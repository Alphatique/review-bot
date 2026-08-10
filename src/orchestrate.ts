import type { Config } from './config';
import { decideEvent, type ReviewEvent } from './core/decision';
import { dedupe, type KeyedFinding } from './core/dedupe';
import { analyzeDiff, isCommentable } from './core/diff';
import { buildPrompt, DEFAULT_INSTRUCTIONS } from './core/prompt';
import {
	renderFailureBody,
	renderInlineComment,
	renderReviewBody,
} from './core/render';
import type { Severity } from './core/schema';
import { pickLiveVerdict } from './core/verdict';
import { type AgentOutcome, SUBMIT_TOOL_NAME } from './io/agent';
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
	event: ReviewEvent;
	counts: Record<Severity, number>;
	findingsCount: number;
	incompleteFiles: number;
	error: string | null;
}

const BOT_AUTHOR_SUFFIX = '[bot]';

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

	const aborted = (error: string): RunResult => ({
		status: 'failed',
		event: 'NONE',
		counts: emptyCounts(),
		findingsCount: 0,
		incompleteFiles: 0,
		error,
	});

	const failure = async (error: string): Promise<RunResult> => {
		log(`review failed: ${error}`);
		try {
			await github.createReview({
				body: renderFailureBody(error, config.language),
				event: 'COMMENT',
				commitId: await safeHeadSha(github),
				comments: [],
			});
		} catch (postError) {
			log(`could not post failure notice: ${describe(postError)}`);
		}
		return aborted(error);
	};

	let pr: PullRequestInfo;
	try {
		pr = await github.getPullRequest();
	} catch (error) {
		return failure(`could not fetch pull request: ${describe(error)}`);
	}

	if (pr.isFork) {
		// fork PR では GITHUB_TOKEN が read-only になり投稿できない。
		// 失敗通知すら投稿できないので createReview を試みない。
		const error =
			'this pull request comes from a fork; GITHUB_TOKEN is read-only and the review cannot be posted';
		log(error);
		return aborted(error);
	}

	try {
		log(`reviewing ${pr.baseSha}...${pr.headSha}`);

		const rawDiff = await github.getDiff(pr.baseSha, pr.headSha);
		const analysis = analyzeDiff(rawDiff, {
			exclude: config.exclude,
			maxBytes: config.diffMaxBytes,
		});

		if (analysis.text.trim() === '') {
			log('no reviewable changes');
			return {
				status: 'success',
				event: 'NONE',
				counts: emptyCounts(),
				findingsCount: 0,
				incompleteFiles: analysis.oversizedFiles.length,
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

		let outcome: AgentOutcome = { ok: false, error: 'not attempted' };
		for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
			log(`agent attempt ${attempt}/${config.maxRetries}`);
			outcome = await deps.runAgent({ prompt });
			if (outcome.ok) break;
			log(`attempt ${attempt} failed: ${outcome.error}`);
		}
		if (!outcome.ok) return failure(outcome.error);

		const existing = await github.listThreads();
		const reviews = await github.listReviews().catch(error => {
			// 判定を出し直す側に倒れる。通知が増えるだけで安全側。
			log(`could not list reviews: ${describe(error)}`);
			return [];
		});
		const liveVerdict = pickLiveVerdict(reviews);

		const { toPost } = dedupe(outcome.findings, existing);

		const inline: InlineCommentInput[] = [];
		/** スレッドが立った指摘。 */
		const tracked: KeyedFinding[] = [];
		/** 投稿に失敗し、スレッドにならなかった指摘。 */
		const untracked: KeyedFinding[] = [];
		/** 差分外を指していて破棄した指摘。 */
		const dropped: KeyedFinding[] = [];

		for (const finding of toPost) {
			if (!analysis.commentableLines.has(finding.file)) {
				// 差分に無いファイルへの指摘。モデルが差分の外を見て組み立てたか、
				// パスを誤ったかのどちらかで、どちらも承認の根拠にならない。
				dropped.push(finding);
				continue;
			}

			const body = renderInlineComment(finding, config.language);
			if (
				finding.line !== null &&
				isCommentable(analysis, finding.file, finding.line)
			) {
				inline.push({ path: finding.file, line: finding.line, body });
				tracked.push(finding);
				continue;
			}

			// 判定より前に投稿する。投稿の失敗が承認の可否に効くため、
			// 判定の後だと fail closed にできない。
			try {
				await github.createFileComment({
					path: finding.file,
					body,
					commitId: pr.headSha,
				});
				tracked.push(finding);
			} catch (error) {
				log(
					`could not post file comment on ${finding.file}: ${describe(error)}`,
				);
				untracked.push(finding);
			}
		}

		const outstanding: Severity[] = [
			...existing.filter(t => !t.isResolved).map(t => t.severity),
			...tracked.map(f => f.severity),
			// 投稿できなくても問題は実在するので未解決として数える。
			...untracked.map(f => f.severity),
		];

		const event = decideEvent({
			outstanding,
			blockOn: config.blockOn,
			approve: config.approve,
			hasUntrackedFindings: dropped.length > 0 || untracked.length > 0,
			canSubmitVerdict: !pr.authorLogin.endsWith(BOT_AUTHOR_SUFFIX),
			liveVerdict,
			hasSomethingToReport:
				tracked.length > 0 || untracked.length > 0 || dropped.length > 0,
		});

		const body = renderReviewBody({
			lang: config.language,
			posted: tracked,
			droppedFiles: dropped.map(f => f.file),
			failedComments: untracked.map(f => f.file),
			excludedFiles: analysis.excludedFiles,
			oversizedFiles: analysis.oversizedFiles,
			resolvedCount: 0,
		});

		if (event !== 'NONE') {
			await github.createReview({
				body,
				event,
				commitId: pr.headSha,
				comments: inline,
			});
		}

		const counts = emptyCounts();
		for (const finding of tracked) counts[finding.severity] += 1;

		log(
			`tracked ${tracked.length} / untracked ${untracked.length} / dropped ${dropped.length}, event=${event}`,
		);

		return {
			status: 'success',
			event,
			counts,
			findingsCount: tracked.length,
			incompleteFiles: analysis.oversizedFiles.length,
			error: null,
		};
	} catch (error) {
		return failure(describe(error));
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function safeHeadSha(github: GitHubClient): Promise<string> {
	try {
		return (await github.getPullRequest()).headSha;
	} catch {
		return '';
	}
}
