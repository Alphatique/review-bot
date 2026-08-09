import { describe, expect, test } from 'bun:test';
import type { Config } from '../src/config';
import type { ThreadInfo } from '../src/core/board';
import { DEFAULT_EXCLUDE } from '../src/core/diff';
import {
	buildRunMarker,
	buildStickyMarker,
	findingKey,
	parseInlineMarker,
	parseRunMarkers,
} from '../src/core/marker';
import type { Finding } from '../src/core/schema';
import type { AgentOutcome } from '../src/io/agent';
import type {
	CreateReviewInput,
	GitHubClient,
	OwnVerdict,
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
	mode: 'auto',
	instructionsFile: '.github/review-instructions.md',
	exclude: [...DEFAULT_EXCLUDE],
	language: 'ja',
	requestChangesOn: 'major',
	failOnError: true,
	failOnIncomplete: false,
	approve: false,
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
	lastReviewed?: string | null;
	sticky?: { commentId: number; body: string } | null;
	diff?: string;
	threads?: ThreadInfo[];
	/** createReview 後の再取得で返すスレッド。未指定なら threads と同じ。 */
	threadsAfterReview?: ThreadInfo[];
	outcomes?: AgentOutcome[];
	instructions?: string | null;
	stickyWriteError?: Error;
	/** getDiff を失敗させて想定外の例外経路を試す。 */
	diffError?: Error;
	/** findSticky を失敗させて「sticky を特定できない」経路を試す。 */
	stickyLookupError?: Error;
	/** dismissReview を失敗させて、abort() の個別 catch を試す。 */
	dismissError?: Error;
	/** listThreads を失敗させて、abort() の個別 catch を試す。 */
	threadsError?: Error;
	/** getOwnVerdict が返す値。未指定なら null（自分の判定が生きていない）。 */
	ownVerdict?: OwnVerdict | null;
	/** getOwnVerdict を失敗させて、abort() 側の個別 catch を試す。 */
	verdictError?: Error;
}

function setup(options: FakeOptions = {}) {
	const reviews: CreateReviewInput[] = [];
	const prompts: string[] = [];
	const diffRequests: { from: string; to: string }[] = [];
	const stickyWrites: { commentId: number | null; body: string }[] = [];
	const dismissals: string[] = [];
	const outcomes = [...(options.outcomes ?? [])];

	const sticky =
		options.sticky ??
		(options.lastReviewed
			? { commentId: 1, body: buildStickyMarker(options.lastReviewed) }
			: null);

	let threadCalls = 0;

	const github: GitHubClient = {
		getPullRequest: async () => ({ ...PR, ...options.pr }),
		getDiff: async (from, to) => {
			diffRequests.push({ from, to });
			if (options.diffError) throw options.diffError;
			return options.diff ?? DIFF;
		},
		listThreads: async () => {
			threadCalls += 1;
			// 成功経路でも listThreads は呼ばれるので、threadsError が
			// 指定されたときだけ投げる。
			if (options.threadsError) throw options.threadsError;
			if (threadCalls > 1 && options.threadsAfterReview) {
				return options.threadsAfterReview;
			}
			return options.threads ?? [];
		},
		findSticky: async () => {
			if (options.stickyLookupError) throw options.stickyLookupError;
			return sticky;
		},
		upsertSticky: async input => {
			if (options.stickyWriteError) throw options.stickyWriteError;
			stickyWrites.push(input);
		},
		createReview: async input => {
			reviews.push(input);
		},
		getOwnVerdict: async () => {
			if (options.verdictError) throw options.verdictError;
			return options.ownVerdict ?? null;
		},
		dismissReview: async (_reviewId, message) => {
			if (options.dismissError) throw options.dismissError;
			dismissals.push(message);
		},
	};

	const deps: OrchestrateDeps = {
		github,
		runAgent: async input => {
			prompts.push(input.prompt);
			return (
				outcomes.shift() ?? {
					ok: true,
					findings: [],
					metrics: { costUsd: 0, durationMs: 0 },
				}
			);
		},
		readInstructions: async () => options.instructions ?? null,
		log: () => {},
	};

	return { deps, reviews, prompts, diffRequests, stickyWrites, dismissals };
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

describe('runReview', () => {
	test('初回は base sha からの差分を取る', async () => {
		const { deps, diffRequests } = setup();
		await runReview(deps, CONFIG);
		expect(diffRequests[0]).toEqual({ from: 'base', to: 'head' });
	});

	test('2 回目以降は前回レビュー地点からの差分を取る', async () => {
		const { deps, diffRequests } = setup({ lastReviewed: 'prev' });
		await runReview(deps, CONFIG);
		expect(diffRequests[0]).toEqual({ from: 'prev', to: 'head' });
	});

	test('mode: full なら前回地点を無視して base から取る', async () => {
		const { deps, diffRequests } = setup({ lastReviewed: 'prev' });
		await runReview(deps, { ...CONFIG, mode: 'full' });
		expect(diffRequests[0]).toEqual({ from: 'base', to: 'head' });
	});

	test('コメント可能行の指摘をインラインコメントとして投稿する', async () => {
		const { deps, reviews } = setup({
			outcomes: [
				{
					ok: true,
					findings: [finding({ line: 2 })],
					metrics: { costUsd: 0.1, durationMs: 1000 },
				},
			],
		});
		await runReview(deps, CONFIG);
		expect(reviews).toHaveLength(1);
		expect(reviews[0]!.comments).toHaveLength(1);
		expect(reviews[0]!.comments[0]!.path).toBe('src/a.ts');
		expect(reviews[0]!.comments[0]!.line).toBe(2);
		expect(parseInlineMarker(reviews[0]!.comments[0]!.body)).not.toBeNull();
	});

	test('行を特定できない指摘はファイル単位コメントとして投稿する', async () => {
		const { deps, reviews } = setup({
			outcomes: [
				{
					ok: true,
					findings: [finding({ line: null })],
					metrics: { costUsd: 0, durationMs: 0 },
				},
			],
		});
		await runReview(deps, CONFIG);
		expect(reviews[0]!.comments).toHaveLength(1);
		expect(reviews[0]!.comments[0]!.line).toBeNull();
		expect(reviews[0]!.comments[0]!.path).toBe('src/a.ts');
	});

	test('差分に無い行の指摘もファイル単位コメントにする', async () => {
		const { deps, reviews } = setup({
			outcomes: [
				{
					ok: true,
					findings: [finding({ line: 999 })],
					metrics: { costUsd: 0, durationMs: 0 },
				},
			],
		});
		await runReview(deps, CONFIG);
		expect(reviews[0]!.comments[0]!.line).toBeNull();
	});

	test('差分に無いファイルの指摘は破棄する', async () => {
		const { deps, reviews } = setup({
			outcomes: [
				{
					ok: true,
					findings: [finding({ file: 'src/other.ts' })],
					metrics: { costUsd: 0, durationMs: 0 },
				},
			],
		});
		const result = await runReview(deps, CONFIG);
		expect(reviews).toHaveLength(0);
		expect(result.findingsCount).toBe(0);
	});

	test('差分に無いファイルの指摘を sticky で報告する', async () => {
		const { deps, stickyWrites } = setup({
			outcomes: [
				{
					ok: true,
					findings: [finding({ file: 'src/other.ts' })],
					metrics: { costUsd: 0, durationMs: 0 },
				},
			],
		});
		await runReview(deps, CONFIG);
		expect(stickyWrites[0]!.body).toContain('`src/other.ts`');
	});

	test('既に CHANGES_REQUESTED なら新規ゼロで Review を作らない', async () => {
		const { deps, reviews } = setup({
			ownVerdict: { id: 1, state: 'CHANGES_REQUESTED' },
			threads: [
				{
					key: 'a'.repeat(12),
					severity: 'critical',
					title: '既存の指摘',
					file: 'src/a.ts',
					line: 2,
					url: 'https://example.test/1',
					isResolved: false,
					isOutdated: false,
				},
			],
		});
		const result = await runReview(deps, CONFIG);
		expect(reviews).toHaveLength(0);
		expect(result.event).toBe('NONE');
	});

	test('閾値以上の指摘があれば REQUEST_CHANGES で提出する', async () => {
		const { deps, reviews } = setup({
			outcomes: [
				{
					ok: true,
					findings: [finding({ severity: 'critical' })],
					metrics: { costUsd: 0.1, durationMs: 1000 },
				},
			],
		});
		await runReview(deps, CONFIG);
		expect(reviews[0]!.event).toBe('REQUEST_CHANGES');
	});

	test('閾値未満なら COMMENT で提出する', async () => {
		const { deps, reviews } = setup({
			outcomes: [
				{
					ok: true,
					findings: [finding({ severity: 'minor' })],
					metrics: { costUsd: 0.1, durationMs: 1000 },
				},
			],
		});
		await runReview(deps, CONFIG);
		expect(reviews[0]!.event).toBe('COMMENT');
	});

	test('bot 自身の PR には REQUEST_CHANGES を出さない', async () => {
		const { deps, reviews } = setup({
			pr: { authorLogin: 'github-actions[bot]' },
			outcomes: [
				{
					ok: true,
					findings: [finding({ severity: 'critical' })],
					metrics: { costUsd: 0.1, durationMs: 1000 },
				},
			],
		});
		await runReview(deps, { ...CONFIG, requestChangesOn: 'critical' });
		expect(reviews[0]!.event).toBe('COMMENT');
	});

	test('既存と重複する指摘は再投稿しない', async () => {
		const f = finding();
		const { deps, reviews } = setup({
			outcomes: [
				{
					ok: true,
					findings: [f],
					metrics: { costUsd: 0.1, durationMs: 1000 },
				},
			],
			threads: [
				{
					key: findingKey(f.file, f.title),
					severity: 'major',
					title: f.title,
					file: f.file,
					line: f.line,
					url: 'https://example.test/1',
					isResolved: false,
					isOutdated: false,
				},
			],
		});
		await runReview(deps, CONFIG);
		expect(reviews[0]!.comments).toHaveLength(0);
	});

	test('未解決の既存指摘があれば REQUEST_CHANGES を維持する', async () => {
		const { deps, reviews } = setup({
			outcomes: [
				{ ok: true, findings: [], metrics: { costUsd: 0.1, durationMs: 1000 } },
			],
			threads: [
				{
					key: 'a'.repeat(12),
					severity: 'critical',
					title: '既存の重大な指摘',
					file: 'src/a.ts',
					line: 1,
					url: 'https://example.test/2',
					isResolved: false,
					isOutdated: false,
				},
			],
		});
		await runReview(deps, CONFIG);
		expect(reviews[0]!.event).toBe('REQUEST_CHANGES');
	});

	test('失敗したらリトライする', async () => {
		const { deps, prompts } = setup({
			outcomes: [
				{
					ok: false,
					error: 'boom',
					metrics: { costUsd: 0.1, durationMs: 1000 },
				},
				{ ok: true, findings: [], metrics: { costUsd: 0.1, durationMs: 1000 } },
			],
		});
		const result = await runReview(deps, CONFIG);
		expect(prompts).toHaveLength(2);
		expect(result.status).toBe('success');
	});

	test('リトライを使い切ったら sticky に失敗を記録し、Review は作らない', async () => {
		const { deps, reviews, stickyWrites } = setup({
			outcomes: [
				{
					ok: false,
					error: 'boom',
					metrics: { costUsd: 0.1, durationMs: 1000 },
				},
				{
					ok: false,
					error: 'boom',
					metrics: { costUsd: 0.1, durationMs: 1000 },
				},
				{
					ok: false,
					error: 'boom',
					metrics: { costUsd: 0.1, durationMs: 1000 },
				},
			],
		});
		const result = await runReview(deps, CONFIG);
		expect(result.status).toBe('failed');
		expect(reviews).toHaveLength(0);
		expect(stickyWrites).toHaveLength(1);
		expect(stickyWrites[0]!.body).toContain('boom');
		// エラー文言だけでなく、固定の失敗バナー文言も出ていることを確認する。
		expect(stickyWrites[0]!.body).toContain(
			'自動レビューを完了できませんでした',
		);
	});

	test('失敗時に reviewed を進めない', async () => {
		const boom = {
			ok: false as const,
			error: 'boom',
			metrics: { costUsd: 0, durationMs: 0 },
		};
		const { deps, stickyWrites } = setup({
			lastReviewed: 'prev',
			outcomes: [boom, boom, boom],
		});
		await runReview(deps, CONFIG);
		expect(stickyWrites[0]!.body).toContain(
			'<!-- review-bot:v1 sticky reviewed=prev -->',
		);
	});

	test('sticky が無い状態で失敗したら base に据え置く', async () => {
		const boom = {
			ok: false as const,
			error: 'boom',
			metrics: { costUsd: 0, durationMs: 0 },
		};
		const { deps, stickyWrites } = setup({ outcomes: [boom, boom, boom] });
		await runReview(deps, CONFIG);
		expect(stickyWrites[0]!.body).toContain(
			'<!-- review-bot:v1 sticky reviewed=base -->',
		);
	});

	test('失敗時に FAILED の run マーカーを追記しコストを乗せる', async () => {
		const boom = {
			ok: false as const,
			error: 'boom',
			metrics: { costUsd: 0.04, durationMs: 1000 },
		};
		const { deps, stickyWrites } = setup({ outcomes: [boom, boom, boom] });
		const result = await runReview(deps, CONFIG);
		const runs = parseRunMarkers(stickyWrites[0]!.body);
		expect(runs).toHaveLength(1);
		expect(runs[0]!.event).toBe('FAILED');
		expect(runs[0]!.attempts).toBe(3);
		expect(result.costUsd).toBeCloseTo(0.12, 4);
		expect(result.totalCostUsd).toBeCloseTo(0.12, 4);
	});

	test('失敗時に自分の APPROVE を取り下げる', async () => {
		const boom = {
			ok: false as const,
			error: 'boom',
			metrics: { costUsd: 0, durationMs: 0 },
		};
		const { deps, dismissals } = setup({
			outcomes: [boom, boom, boom],
			ownVerdict: { id: 1, state: 'APPROVED' },
		});
		await runReview(deps, CONFIG);
		expect(dismissals).toHaveLength(1);
	});

	test('成功時は APPROVE を取り下げない', async () => {
		const { deps, dismissals } = setup();
		await runReview(deps, CONFIG);
		expect(dismissals).toHaveLength(0);
	});

	test('APPROVE の取り下げが失敗してもバナーは書かれる', async () => {
		const boom = {
			ok: false as const,
			error: 'boom',
			metrics: { costUsd: 0, durationMs: 0 },
		};
		const { deps, stickyWrites } = setup({
			outcomes: [boom, boom, boom],
			dismissError: new Error('403'),
			ownVerdict: { id: 1, state: 'APPROVED' },
		});
		const result = await runReview(deps, CONFIG);
		expect(result.status).toBe('failed');
		expect(stickyWrites).toHaveLength(1);
		expect(stickyWrites[0]!.body).toContain('boom');
	});

	test('スレッド取得が失敗してもバナーは書かれる', async () => {
		const boom = {
			ok: false as const,
			error: 'boom',
			metrics: { costUsd: 0, durationMs: 0 },
		};
		const { deps, stickyWrites } = setup({
			outcomes: [boom, boom, boom],
			threadsError: new Error('502'),
		});
		const result = await runReview(deps, CONFIG);
		expect(result.status).toBe('failed');
		expect(stickyWrites[0]!.body).toContain('boom');
	});

	test('判定の取得が失敗してもバナーは書かれる', async () => {
		const boom = {
			ok: false as const,
			error: 'boom',
			metrics: { costUsd: 0, durationMs: 0 },
		};
		const { deps, stickyWrites } = setup({
			outcomes: [boom, boom, boom],
			verdictError: new Error('403'),
		});
		const result = await runReview(deps, CONFIG);
		expect(result.status).toBe('failed');
		expect(stickyWrites[0]!.body).toContain('boom');
	});

	test('エージェントが走る前に失敗したら実行情報を出さない', async () => {
		// attempts が 0 のまま実行情報を出すと「エージェントが走ってコストゼロ
		// だった」ように読める。
		const { deps, stickyWrites } = setup({
			diffError: new Error('502 from GitHub'),
		});
		await runReview(deps, CONFIG);
		expect(stickyWrites[0]!.body).not.toContain('実行情報');
	});

	test('COMMENT の Review でも body を空にしない', async () => {
		// event: COMMENT の Review に空 body を渡すと GitHub が 422 を返す。
		// major/major だと REQUEST_CHANGES に倒れて COMMENT 経路を通らないので、
		// minor の指摘と閾値 critical を組み合わせて確実に COMMENT にする。
		const { deps, reviews } = setup({
			outcomes: [
				{
					ok: true,
					findings: [finding({ severity: 'minor', line: 2 })],
					metrics: { costUsd: 0, durationMs: 0 },
				},
			],
		});
		await runReview(deps, { ...CONFIG, requestChangesOn: 'critical' });
		expect(reviews[0]!.event).toBe('COMMENT');
		expect(reviews[0]!.body.trim().length).toBeGreaterThan(0);
	});

	test('差分が空ならレビューを投稿せず成功で終わる', async () => {
		const { deps, reviews } = setup({ diff: '' });
		const result = await runReview(deps, CONFIG);
		expect(reviews).toHaveLength(0);
		expect(result.status).toBe('success');
		expect(result.event).toBe('NONE');
	});

	test('fork PR は失敗として扱う', async () => {
		// fork では GITHUB_TOKEN が read-only になるので sticky も書けない。
		// 書こうとして 403 で落ちるより、最初から何も呼ばない方が安全。
		const { deps, reviews, stickyWrites } = setup({ pr: { isFork: true } });
		const result = await runReview(deps, CONFIG);
		expect(result.status).toBe('failed');
		expect(reviews).toHaveLength(0);
		expect(stickyWrites).toHaveLength(0);
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
					metrics: { costUsd: 0.1, durationMs: 1000 },
				},
			],
		});
		const result = await runReview(deps, CONFIG);
		expect(result.counts.critical).toBe(1);
		expect(result.counts.major).toBe(2);
		expect(result.counts.minor).toBe(0);
	});

	test('指摘ゼロなら Review を作らず sticky だけ更新する', async () => {
		const { deps, reviews, stickyWrites } = setup();
		const result = await runReview(deps, CONFIG);
		expect(reviews).toHaveLength(0);
		expect(stickyWrites).toHaveLength(1);
		expect(result.event).toBe('NONE');
		expect(result.status).toBe('success');
	});

	test('sticky に head sha を書き込む', async () => {
		const { deps, stickyWrites } = setup();
		await runReview(deps, CONFIG);
		expect(stickyWrites[0]!.body).toContain(
			'<!-- review-bot:v1 sticky reviewed=head -->',
		);
	});

	test('sticky が無ければ新規作成する', async () => {
		const { deps, stickyWrites } = setup();
		await runReview(deps, CONFIG);
		expect(stickyWrites[0]!.commentId).toBeNull();
	});

	test('sticky があれば同じコメントを更新する', async () => {
		const { deps, stickyWrites } = setup({ lastReviewed: 'prev' });
		await runReview(deps, CONFIG);
		expect(stickyWrites[0]!.commentId).toBe(1);
	});

	test('run マーカーを追記し、過去分を残す', async () => {
		const { deps, stickyWrites } = setup({
			sticky: {
				commentId: 1,
				body: `${buildStickyMarker('prev')}\n${buildRunMarker({
					commit: 'prev',
					mode: 'auto',
					newFindings: 2,
					event: 'COMMENT',
					costUsd: 0.5,
					seconds: 30,
					attempts: 1,
					model: 'claude-sonnet-5',
					effort: 'high',
				})}`,
			},
		});
		await runReview(deps, CONFIG);
		const runs = parseRunMarkers(stickyWrites[0]!.body);
		expect(runs.map(r => r.commit)).toEqual(['prev', 'head']);
	});

	test('コストを合算して返す', async () => {
		const { deps } = setup({
			outcomes: [
				{
					ok: false,
					error: 'boom',
					metrics: { costUsd: 0.1, durationMs: 1000 },
				},
				{
					ok: true,
					findings: [],
					metrics: { costUsd: 0.2, durationMs: 2000 },
				},
			],
		});
		const result = await runReview(deps, CONFIG);
		expect(result.costUsd).toBeCloseTo(0.3, 4);
	});

	test('リトライ回数を run マーカーに書く', async () => {
		const { deps, stickyWrites } = setup({
			outcomes: [
				{
					ok: false,
					error: 'boom',
					metrics: { costUsd: 0.1, durationMs: 1000 },
				},
				{
					ok: true,
					findings: [],
					metrics: { costUsd: 0.2, durationMs: 2000 },
				},
			],
		});
		await runReview(deps, CONFIG);
		expect(parseRunMarkers(stickyWrites[0]!.body)[0]!.attempts).toBe(2);
	});

	test('累計コストは過去の run マーカーを含む', async () => {
		const { deps } = setup({
			sticky: {
				commentId: 1,
				body: `${buildStickyMarker('prev')}\n${buildRunMarker({
					commit: 'prev',
					mode: 'auto',
					newFindings: 0,
					event: 'NONE',
					costUsd: 0.5,
					seconds: 10,
					attempts: 1,
					model: 'm',
					effort: 'high',
				})}`,
			},
			outcomes: [
				{
					ok: true,
					findings: [],
					metrics: { costUsd: 0.25, durationMs: 1000 },
				},
			],
		});
		const result = await runReview(deps, CONFIG);
		expect(result.totalCostUsd).toBeCloseTo(0.75, 4);
	});

	test('approve が有効で未解決ゼロなら APPROVE を出す', async () => {
		const { deps, reviews } = setup();
		const result = await runReview(deps, { ...CONFIG, approve: true });
		expect(result.event).toBe('APPROVE');
		expect(reviews[0]!.event).toBe('APPROVE');
	});

	test('既に APPROVED なら未解決ゼロでも再承認しない', async () => {
		const { deps, reviews } = setup({
			ownVerdict: { id: 1, state: 'APPROVED' },
		});
		const result = await runReview(deps, { ...CONFIG, approve: true });
		expect(reviews).toHaveLength(0);
		expect(result.event).toBe('NONE');
	});

	test('request-changes-on が none でも approve 側は判定を取得して再承認を防ぐ', async () => {
		// threshold だけを見て判定取得をスキップすると、この組み合わせ
		// （ブロックはしないが承認はする設定）で APPROVE が毎回出てしまう。
		const { deps, reviews } = setup({
			ownVerdict: { id: 1, state: 'APPROVED' },
		});
		const result = await runReview(deps, {
			...CONFIG,
			requestChangesOn: 'none',
			approve: true,
		});
		expect(reviews).toHaveLength(0);
		expect(result.event).toBe('NONE');
	});

	test('sticky の upsert が失敗してもレビューは成功扱い', async () => {
		const { deps } = setup({ stickyWriteError: new Error('rate limited') });
		const result = await runReview(deps, CONFIG);
		expect(result.status).toBe('success');
	});

	test('想定外の例外も sticky に失敗バナーとして残す', async () => {
		const { deps, stickyWrites, reviews } = setup({
			diffError: new Error('502 from GitHub'),
		});
		const result = await runReview(deps, CONFIG);
		expect(result.status).toBe('failed');
		expect(result.error).toContain('502 from GitHub');
		expect(reviews).toHaveLength(0);
		expect(stickyWrites).toHaveLength(1);
		expect(stickyWrites[0]!.body).toContain('502 from GitHub');
		expect(parseRunMarkers(stickyWrites[0]!.body)[0]!.event).toBe('FAILED');
	});

	test('sticky を特定できないまま失敗したら sticky を書かない', async () => {
		// findSticky が失敗した状態で新規作成すると sticky が二重になる。
		const { deps, stickyWrites } = setup({
			stickyLookupError: new Error('403'),
		});
		const result = await runReview(deps, CONFIG);
		expect(result.status).toBe('failed');
		expect(stickyWrites).toHaveLength(0);
	});

	test('board の再取得結果を sticky に描く', async () => {
		const { deps, stickyWrites } = setup({
			outcomes: [
				{
					ok: true,
					findings: [finding({ line: 2 })],
					metrics: { costUsd: 0, durationMs: 0 },
				},
			],
			threadsAfterReview: [
				{
					key: 'b'.repeat(12),
					severity: 'critical',
					title: '再取得で見えた指摘',
					file: 'src/a.ts',
					line: 2,
					url: 'https://example.test/9',
					isResolved: false,
					isOutdated: false,
				},
			],
		});
		await runReview(deps, CONFIG);
		expect(stickyWrites[0]!.body).toContain('再取得で見えた指摘');
	});
});
