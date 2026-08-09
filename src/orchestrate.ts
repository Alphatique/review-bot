import type { Config } from './config';
import { buildBoard, type Board } from './core/board';
import {
	decideEvent,
	type EventDecision,
	type OwnVerdictState,
} from './core/decision';
import { dedupe, type KeyedFinding } from './core/dedupe';
import { analyzeDiff, isCommentable } from './core/diff';
import { messages, type LatestRun } from './core/i18n';
import {
	parseRunMarkers,
	parseStickyMarker,
	type RunRecord,
	totalCostUsd,
} from './core/marker';
import { buildPrompt, DEFAULT_INSTRUCTIONS } from './core/prompt';
import { renderInlineComment, renderSticky } from './core/render';
import type { Severity } from './core/schema';
import {
	type AgentMetrics,
	type AgentOutcome,
	SUBMIT_TOOL_NAME,
} from './io/agent';
import type {
	GitHubClient,
	InlineCommentInput,
	PullRequestInfo,
} from './io/github';

export interface AgentRunRequest {
	prompt: string;
}

export interface OrchestrateDeps {
	github: GitHubClient;
	runAgent(input: AgentRunRequest): Promise<AgentOutcome>;
	/** instructions-file を読む。存在しなければ null。 */
	readInstructions(path: string): Promise<string | null>;
	log(message: string): void;
}

export interface RunResult {
	status: 'success' | 'failed';
	event: EventDecision;
	counts: Record<Severity, number>;
	findingsCount: number;
	incompleteFiles: number;
	/** この実行のコスト（全 attempt 合計）。 */
	costUsd: number;
	/** PR 全体の累計コスト。 */
	totalCostUsd: number;
	error: string | null;
}

const BOT_AUTHOR_SUFFIX = '[bot]';

const DISMISS_MESSAGE =
	'The automated review could not be completed, so this approval is no longer valid.';

export async function runReview(
	deps: OrchestrateDeps,
	config: Config,
): Promise<RunResult> {
	const { github, log } = deps;

	const emptyCounts = (): Record<Severity, number> => ({
		critical: 0,
		major: 0,
		minor: 0,
	});

	let pr: PullRequestInfo;
	try {
		pr = await github.getPullRequest();
	} catch (error) {
		const message = `could not fetch pull request: ${describe(error)}`;
		log(message);
		return {
			status: 'failed',
			event: 'NONE',
			counts: emptyCounts(),
			findingsCount: 0,
			incompleteFiles: 0,
			costUsd: 0,
			totalCostUsd: 0,
			error: message,
		};
	}

	if (pr.isFork) {
		// fork PR では GITHUB_TOKEN が read-only になり投稿できない。
		// 失敗通知すら投稿できないので API 呼び出しを試みない。
		const error =
			'this pull request comes from a fork; GITHUB_TOKEN is read-only and the review cannot be posted';
		log(error);
		return {
			status: 'failed',
			event: 'NONE',
			counts: emptyCounts(),
			findingsCount: 0,
			incompleteFiles: 0,
			costUsd: 0,
			totalCostUsd: 0,
			error,
		};
	}

	// 失敗経路と成功経路で共有する状態。abort() が途中までの値を使って
	// sticky を書けるよう、try の外で持つ。
	let sticky: { commentId: number; body: string } | null = null;
	let stickyResolved = false;
	let previousRuns: RunRecord[] = [];
	let lastReviewed: string | null = null;
	let oversizedFiles: readonly string[] = [];
	const spent: AgentMetrics = { costUsd: 0, durationMs: 0 };
	let attempts = 0;

	/** sticky を書く。失敗してもレビュー自体は落とさない。 */
	const writeSticky = async (input: {
		reviewedSha: string;
		runs: readonly RunRecord[];
		board: Board;
		latest: LatestRun | null;
		/** 失敗したときのエラー本文と、レビューできなかった commit。成功時は null。 */
		failure: { message: string; sha: string } | null;
		/** 差分に無いファイルを狙っていたため破棄した指摘のファイル名。 */
		droppedFiles: readonly string[];
	}): Promise<void> => {
		// findSticky に失敗していると既存コメントの id が分からない。ここで
		// 新規作成すると sticky が二重になるので、何もせず記録だけ残す。
		if (!stickyResolved) {
			log('skipped the summary comment: the existing one could not be located');
			return;
		}
		try {
			await github.upsertSticky({
				commentId: sticky?.commentId ?? null,
				body: renderSticky({ lang: config.language, oversizedFiles, ...input }),
			});
		} catch (error) {
			// reviewed が進まないので次回同じ範囲を再レビューするが、
			// dedupe があるので二重投稿にはならない。安全側に倒れる。
			log(`could not update the summary comment: ${describe(error)}`);
		}
	};

	const latestRun = (succeeded: boolean): LatestRun => ({
		model: config.model,
		effort: config.effort,
		seconds: Math.round(spent.durationMs / 1000),
		costUsd: spent.costUsd,
		attempts: Math.max(attempts, 1),
		succeeded,
	});

	const record = (
		event: RunRecord['event'],
		newFindings: number,
	): RunRecord[] => [
		...previousRuns,
		{
			commit: pr.headSha,
			mode: config.mode,
			newFindings,
			event,
			costUsd: spent.costUsd,
			seconds: Math.round(spent.durationMs / 1000),
			attempts: Math.max(attempts, 1),
			model: config.model,
			effort: config.effort,
		},
	];

	/** 失敗を sticky に残して RunResult を返す共通経路。 */
	const abort = async (error: string): Promise<RunResult> => {
		log(`review failed: ${error}`);
		const runs = record('FAILED', 0);

		// 古い APPROVE が残ると PR が緑に見える。fail-on-error が防ごうとしている
		// 状況そのものなので取り下げる。abort() は成功経路の getOwnVerdict() より
		// 前に走ることがあるので、ここで独自に取り直す。
		try {
			const verdict = await github.getOwnVerdict();
			if (verdict?.state === 'APPROVED') {
				await github.dismissReview(verdict.id, DISMISS_MESSAGE);
			}
		} catch (dismissError) {
			log(`could not dismiss the stale approval: ${describe(dismissError)}`);
		}

		// スレッド取得も失敗しうる。バナーだけでも残す方が無言より良い。
		let board = buildBoard([]);
		try {
			board = buildBoard(await github.listThreads());
		} catch (threadError) {
			log(`could not list review threads: ${describe(threadError)}`);
		}

		await writeSticky({
			// 失敗した範囲を二度とレビューしないことになるので reviewed は進めない。
			reviewedSha: lastReviewed ?? pr.baseSha,
			runs,
			board,
			// attempts が 0 のままなら agent は一度も起動していない。それでも
			// latestRun() を呼ぶと「コスト $0.00 で実行した」ように読めてしまう。
			// succeeded は常に false — abort() に来る時点でこの実行は失敗している。
			latest: attempts > 0 ? latestRun(false) : null,
			failure: { message: error, sha: pr.headSha },
			// abort() では指摘の組み立てまで到達しないので破棄は発生しない。
			droppedFiles: [],
		});

		return {
			status: 'failed',
			event: 'NONE',
			counts: emptyCounts(),
			findingsCount: 0,
			incompleteFiles: oversizedFiles.length,
			costUsd: spent.costUsd,
			totalCostUsd: totalCostUsd(runs),
			error,
		};
	};

	try {
		sticky = await github.findSticky();
		stickyResolved = true;
		previousRuns = sticky ? parseRunMarkers(sticky.body) : [];
		lastReviewed = sticky
			? (parseStickyMarker(sticky.body)?.reviewed ?? null)
			: null;

		const from =
			config.mode === 'full' ? pr.baseSha : (lastReviewed ?? pr.baseSha);
		log(`reviewing ${from}...${pr.headSha} (mode=${config.mode})`);

		const rawDiff = await github.getDiff(from, pr.headSha);
		const analysis = analyzeDiff(rawDiff, {
			exclude: config.exclude,
			maxBytes: config.diffMaxBytes,
		});
		oversizedFiles = analysis.oversizedFiles;

		if (analysis.text.trim() === '') {
			log('no reviewable changes');
			await writeSticky({
				reviewedSha: pr.headSha,
				runs: previousRuns,
				board: buildBoard(await github.listThreads()),
				latest: null,
				failure: null,
				// エージェントを起動していないので破棄も発生しない。
				droppedFiles: [],
			});
			return {
				status: 'success',
				event: 'NONE',
				counts: emptyCounts(),
				findingsCount: 0,
				incompleteFiles: oversizedFiles.length,
				costUsd: 0,
				totalCostUsd: totalCostUsd(previousRuns),
				error: null,
			};
		}

		const instructions =
			(await deps.readInstructions(config.instructionsFile)) ??
			DEFAULT_INSTRUCTIONS;

		const prompt = buildPrompt({
			instructions,
			repo: config.repo,
			prNumber: pr.number,
			prTitle: pr.title,
			diff: analysis.text,
			lang: config.language,
			oversizedFiles: analysis.oversizedFiles,
			toolName: SUBMIT_TOOL_NAME,
		});

		let outcome: AgentOutcome = {
			ok: false,
			error: 'not attempted',
			metrics: { costUsd: 0, durationMs: 0 },
		};

		for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
			attempts = attempt;
			log(`agent attempt ${attempt}/${config.maxRetries}`);
			outcome = await deps.runAgent({ prompt });
			spent.costUsd += outcome.metrics.costUsd;
			spent.durationMs += outcome.metrics.durationMs;
			if (outcome.ok) break;
			log(`attempt ${attempt} failed: ${outcome.error}`);
		}

		if (!outcome.ok) return await abort(outcome.error);

		const existing = await github.listThreads();

		const canSubmitVerdict = !pr.authorLogin.endsWith(BOT_AUTHOR_SUFFIX);

		// 判定は REQUEST_CHANGES 側か APPROVE 側のどちらかが実際に参照しうる
		// ときしか使わない。使わない実行で listReviews を叩くと、無関係な API
		// 障害で成功した実行を落としかねない。approve: true かつ
		// request-changes-on: none（ブロックはしないが承認はする設定）でも
		// APPROVE 側が参照するので、threshold だけでは判定できない。
		let currentVerdict: OwnVerdictState | null = null;
		if (
			canSubmitVerdict &&
			(config.requestChangesOn !== 'none' || config.approve)
		) {
			try {
				currentVerdict = (await github.getOwnVerdict())?.state ?? null;
			} catch (error) {
				// 取れなければ「判定は無い」とみなす。再表明が 1 回増えるだけで、
				// 成功した実行を丸ごと落とすよりずっと軽い。
				log(`could not read the current verdict: ${describe(error)}`);
			}
		}

		const { toPost } = dedupe(outcome.findings, existing);

		const comments: InlineCommentInput[] = [];
		const posted: KeyedFinding[] = [];
		const droppedFiles = new Set<string>();
		for (const finding of toPost) {
			// 差分に無いファイルは投稿先が無い。プロンプトで禁止している（Task 10）が、
			// それでも出てきた場合は破棄してログに残す。PR 上にも痕跡を残さないと
			// モデルが何を言おうとしたのか誰にも分からないので、sticky にも出す。
			if (!analysis.commentableLines.has(finding.file)) {
				log(`dropped a finding outside the diff: ${finding.file}`);
				droppedFiles.add(finding.file);
				continue;
			}
			// 行が差分内に無ければファイル単位コメントに落とす。スレッドは立つので
			// サマリーの索引には載る。
			const line = isCommentable(analysis, finding.file, finding.line ?? -1)
				? finding.line
				: null;
			comments.push({
				path: finding.file,
				line,
				body: renderInlineComment(finding, config.language),
			});
			posted.push(finding);
		}

		const event = decideEvent({
			newFindings: posted,
			existing,
			threshold: config.requestChangesOn,
			canSubmitVerdict,
			approve: config.approve,
			currentVerdict,
		});

		if (event !== 'NONE') {
			await github.createReview({
				body: messages(config.language).reviewPointer,
				event,
				commitId: pr.headSha,
				comments,
			});
		}

		// 投稿後に取り直す。サマリーを常に GitHub の現状から組み立てるため。
		// event が NONE なら createReview を呼んでいないので新しいスレッドは無く、
		// existing がそのまま最新。ここで余計に叩くと、指摘ゼロの成功した実行が
		// API の一時失敗だけで失敗扱いになる。
		const threads = event === 'NONE' ? existing : await github.listThreads();
		const runs = record(event, posted.length);

		await writeSticky({
			reviewedSha: pr.headSha,
			runs,
			board: buildBoard(threads),
			latest: latestRun(true),
			failure: null,
			droppedFiles: [...droppedFiles],
		});

		const counts = emptyCounts();
		for (const finding of posted) counts[finding.severity] += 1;

		log(`posted ${comments.length} comment(s), event=${event}`);

		return {
			status: 'success',
			event,
			counts,
			findingsCount: posted.length,
			incompleteFiles: oversizedFiles.length,
			costUsd: spent.costUsd,
			totalCostUsd: totalCostUsd(runs),
			error: null,
		};
	} catch (error) {
		// ここを抜けた例外は main() を落とすだけで sticky に何も残らない。
		// 失敗経路に合流させ、バナーと FAILED の run マーカーを残す。
		return await abort(describe(error));
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
