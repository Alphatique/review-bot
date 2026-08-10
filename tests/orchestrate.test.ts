import { describe, expect, test } from 'bun:test';
import type { Config } from '../src/config';
import { DEFAULT_EXCLUDE } from '../src/core/diff';
import {
	findingKey,
	parseInlineMarker,
	REVIEW_MARKER,
} from '../src/core/marker';
import type { Finding } from '../src/core/schema';
import type { ThreadInfo } from '../src/core/thread';
import type { ReviewRecord } from '../src/core/verdict';
import type { AgentOutcome } from '../src/io/agent';
import type {
	CreateReviewInput,
	GitHubClient,
	PullRequestInfo,
} from '../src/io/github';
import { type OrchestrateDeps, runReview } from '../src/orchestrate';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
 const z = 3;
`;

const CONFIG: Config = {
	auth: { kind: 'oauth', value: 'tok' },
	githubToken: 'ghs_x',
	repo: 'owner/repo',
	prNumber: 42,
	instructionsFile: '.github/review-instructions.md',
	exclude: [...DEFAULT_EXCLUDE],
	language: 'ja',
	blockOn: 'major',
	approve: true,
	failOnError: true,
	failOnIncomplete: false,
	model: 'claude-sonnet-5',
	effort: 'high',
	maxRetries: 3,
	timeoutMs: 60_000,
	maxCostUsd: 5,
	diffMaxBytes: 500_000,
};

const PR: PullRequestInfo = {
	baseSha: 'base',
	headSha: 'head',
	title: 'feat: add y',
	number: 42,
	authorLogin: 'someone',
	isFork: false,
	isDraft: false,
};

interface FakeOptions {
	pr?: Partial<PullRequestInfo>;
	diff?: string;
	existing?: ThreadInfo[];
	existingReviews?: ReviewRecord[];
	outcomes?: AgentOutcome[];
	instructions?: string | null;
}

function setup(options: FakeOptions = {}) {
	const reviews: CreateReviewInput[] = [];
	const prompts: string[] = [];
	const diffRequests: { from: string; to: string }[] = [];
	const outcomes = [...(options.outcomes ?? [])];
	const dismissals: { reviewId: number; message: string }[] = [];

	const github: GitHubClient = {
		getPullRequest: async () => ({ ...PR, ...options.pr }),
		getDiff: async (from, to) => {
			diffRequests.push({ from, to });
			return options.diff ?? DIFF;
		},
		listThreads: async () => options.existing ?? [],
		createReview: async input => {
			reviews.push(input);
		},
		listReviews: async () => options.existingReviews ?? [],
		dismissReview: async (reviewId, message) => {
			dismissals.push({ reviewId, message });
		},
	};

	const deps: OrchestrateDeps = {
		github,
		runAgent: async input => {
			prompts.push(input.prompt);
			return outcomes.shift() ?? { ok: true, findings: [] };
		},
		readInstructions: async () => options.instructions ?? null,
		log: () => {},
	};

	return { deps, reviews, prompts, diffRequests, dismissals };
}

function finding(overrides: Partial<Finding> = {}): Finding {
	return {
		severity: 'major',
		file: 'src/a.ts',
		line: 2,
		title: '未使用の変数',
		body: 'y が使われていない',
		...overrides,
	};
}

function thread(overrides: Partial<ThreadInfo> = {}): ThreadInfo {
	return {
		id: 'PRRT_1',
		commentId: 1,
		key: 'a'.repeat(12),
		severity: 'major',
		file: 'src/a.ts',
		line: 2,
		title: '未使用の変数',
		isResolved: false,
		isOutdated: false,
		...overrides,
	};
}

describe('runReview', () => {
	test('常に base sha からの差分を取る', async () => {
		const { deps, diffRequests } = setup();
		await runReview(deps, CONFIG);
		expect(diffRequests[0]).toEqual({ from: 'base', to: 'head' });
	});

	test('コメント可能行の指摘をインラインコメントとして投稿する', async () => {
		const { deps, reviews } = setup({
			outcomes: [{ ok: true, findings: [finding({ line: 2 })] }],
		});
		await runReview(deps, CONFIG);
		expect(reviews).toHaveLength(1);
		expect(reviews[0]!.comments).toHaveLength(1);
		expect(reviews[0]!.comments[0]!.path).toBe('src/a.ts');
		expect(reviews[0]!.comments[0]!.line).toBe(2);
		expect(parseInlineMarker(reviews[0]!.comments[0]!.body)).not.toBeNull();
	});

	test('コメント可能行でない指摘はサマリへ落とす', async () => {
		const { deps, reviews } = setup({
			outcomes: [{ ok: true, findings: [finding({ line: 999 })] }],
		});
		await runReview(deps, CONFIG);
		expect(reviews[0]!.comments).toHaveLength(0);
		expect(reviews[0]!.body).toContain('未使用の変数');
	});

	test('line が null の指摘はサマリへ落とす', async () => {
		const { deps, reviews } = setup({
			outcomes: [{ ok: true, findings: [finding({ line: null })] }],
		});
		await runReview(deps, CONFIG);
		expect(reviews[0]!.comments).toHaveLength(0);
		expect(reviews[0]!.body).toContain('未使用の変数');
	});

	test('閾値以上の指摘があれば REQUEST_CHANGES で提出する', async () => {
		const { deps, reviews } = setup({
			outcomes: [{ ok: true, findings: [finding({ severity: 'critical' })] }],
		});
		await runReview(deps, CONFIG);
		expect(reviews[0]!.event).toBe('REQUEST_CHANGES');
	});

	test('閾値未満なら APPROVE で提出する', async () => {
		const { deps, reviews } = setup({
			outcomes: [{ ok: true, findings: [finding({ severity: 'minor' })] }],
		});
		await runReview(deps, CONFIG);
		expect(reviews[0]!.event).toBe('APPROVE');
	});

	test('bot 自身の PR には REQUEST_CHANGES を出さない', async () => {
		const { deps, reviews } = setup({
			pr: { authorLogin: 'github-actions[bot]' },
			outcomes: [{ ok: true, findings: [finding({ severity: 'critical' })] }],
		});
		await runReview(deps, { ...CONFIG, blockOn: 'critical' });
		expect(reviews[0]!.event).toBe('COMMENT');
	});

	test('既存と重複する指摘は再投稿しない', async () => {
		const f = finding();
		const { deps, reviews } = setup({
			outcomes: [{ ok: true, findings: [f] }],
			existing: [thread({ key: findingKey(f.file, f.title) })],
		});
		await runReview(deps, CONFIG);
		expect(reviews[0]!.comments).toHaveLength(0);
	});

	test('resolve 済みの既存指摘でも再投稿しない', async () => {
		const f = finding();
		const { deps, reviews } = setup({
			outcomes: [{ ok: true, findings: [f] }],
			existing: [
				thread({ key: findingKey(f.file, f.title), isResolved: true }),
			],
		});
		await runReview(deps, CONFIG);
		expect(reviews[0]!.comments).toHaveLength(0);
	});

	test('outdated な既存指摘でも再投稿しない', async () => {
		const f = finding();
		const { deps, reviews } = setup({
			outcomes: [{ ok: true, findings: [f] }],
			existing: [
				thread({ key: findingKey(f.file, f.title), isOutdated: true }),
			],
		});
		await runReview(deps, CONFIG);
		expect(reviews[0]!.comments).toHaveLength(0);
	});

	test('未解決の既存指摘があれば REQUEST_CHANGES を維持する', async () => {
		const { deps, reviews } = setup({
			outcomes: [{ ok: true, findings: [] }],
			existing: [thread({ severity: 'critical' })],
		});
		await runReview(deps, CONFIG);
		expect(reviews[0]!.event).toBe('REQUEST_CHANGES');
	});

	test('失敗したらリトライする', async () => {
		const { deps, prompts } = setup({
			outcomes: [
				{ ok: false, error: 'boom' },
				{ ok: true, findings: [] },
			],
		});
		const result = await runReview(deps, CONFIG);
		expect(prompts).toHaveLength(2);
		expect(result.status).toBe('success');
	});

	test('リトライを使い切ったら失敗通知を投稿する', async () => {
		const { deps, reviews } = setup({
			outcomes: [
				{ ok: false, error: 'boom' },
				{ ok: false, error: 'boom' },
				{ ok: false, error: 'boom' },
			],
		});
		const result = await runReview(deps, CONFIG);
		expect(result.status).toBe('failed');
		expect(reviews).toHaveLength(1);
		expect(reviews[0]!.event).toBe('COMMENT');
		expect(reviews[0]!.body).toContain(REVIEW_MARKER);
		expect(reviews[0]!.body).toContain('boom');
	});

	test('差分が空ならレビューを投稿せず成功で終わる', async () => {
		const { deps, reviews } = setup({ diff: '' });
		const result = await runReview(deps, CONFIG);
		expect(reviews).toHaveLength(0);
		expect(result.status).toBe('success');
		expect(result.event).toBe('NONE');
	});

	test('fork PR は失敗として扱う', async () => {
		const { deps, reviews } = setup({ pr: { isFork: true } });
		const result = await runReview(deps, CONFIG);
		expect(result.status).toBe('failed');
		expect(reviews).toHaveLength(0);
	});

	test('instructions-file があればそれを使う', async () => {
		const { deps, prompts } = setup({ instructions: 'タブを使うこと' });
		await runReview(deps, CONFIG);
		expect(prompts[0]).toContain('タブを使うこと');
	});

	test('プロンプトに repo を渡す', async () => {
		const { deps, prompts } = setup();
		await runReview(deps, CONFIG);
		expect(prompts[0]).toContain('owner/repo');
	});

	test('重大度ごとの件数を返す', async () => {
		const { deps } = setup({
			outcomes: [
				{
					ok: true,
					findings: [
						finding({ severity: 'critical', title: 'a' }),
						finding({ severity: 'major', title: 'b' }),
						finding({ severity: 'major', title: 'c' }),
					],
				},
			],
		});
		const result = await runReview(deps, CONFIG);
		expect(result.counts.critical).toBe(1);
		expect(result.counts.major).toBe(2);
		expect(result.counts.minor).toBe(0);
	});

	test('新規指摘も判定の変化も無ければ Review を作らない', async () => {
		const { deps, reviews } = setup({
			outcomes: [{ ok: true, findings: [] }],
			existingReviews: [
				{ id: 1, body: `済\n${REVIEW_MARKER}`, state: 'APPROVED' },
			],
		});
		const result = await runReview(deps, CONFIG);
		expect(reviews).toHaveLength(0);
		expect(result.event).toBe('NONE');
	});

	test('指摘が無ければ APPROVE を出す', async () => {
		const { deps, reviews } = setup({ outcomes: [{ ok: true, findings: [] }] });
		await runReview(deps, CONFIG);
		expect(reviews[0]!.event).toBe('APPROVE');
	});
});
