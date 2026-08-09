import type { Config } from './config';
import { decideEvent, type ReviewEvent } from './core/decision';
import { dedupe, type KeyedFinding } from './core/dedupe';
import { analyzeDiff, isCommentable } from './core/diff';
import { buildPrompt, DEFAULT_INSTRUCTIONS } from './core/prompt';
import {
	renderFailureSummary,
	renderInlineComment,
	renderSummary,
} from './core/render';
import type { Severity } from './core/schema';
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
	event: ReviewEvent | 'NONE';
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
				body: renderFailureSummary(error, config.language),
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
		const lastReviewed =
			config.mode === 'full' ? null : await github.getLastReviewedCommit();
		const from = lastReviewed ?? pr.baseSha;
		log(`reviewing ${from}...${pr.headSha} (mode=${config.mode})`);

		const rawDiff = await github.getDiff(from, pr.headSha);
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

		const existing = await github.listExistingFindings();
		const { toPost } = dedupe(outcome.findings, existing);

		const inline: InlineCommentInput[] = [];
		const posted: KeyedFinding[] = [];
		const unlocatable: KeyedFinding[] = [];
		for (const finding of toPost) {
			if (
				finding.line !== null &&
				isCommentable(analysis, finding.file, finding.line)
			) {
				inline.push({
					path: finding.file,
					line: finding.line,
					body: renderInlineComment(finding, config.language),
				});
				posted.push(finding);
			} else {
				unlocatable.push(finding);
			}
		}

		const event = decideEvent({
			newFindings: toPost,
			existing,
			threshold: config.requestChangesOn,
			canSubmitVerdict: !pr.authorLogin.endsWith(BOT_AUTHOR_SUFFIX),
			approve: false,
		});

		const body = renderSummary({
			lang: config.language,
			posted,
			unlocatable,
			excludedFiles: analysis.excludedFiles,
			oversizedFiles: analysis.oversizedFiles,
			mode: config.mode,
		});

		await github.createReview({
			body,
			event: event === 'NONE' ? 'COMMENT' : event,
			commitId: pr.headSha,
			comments: inline,
		});

		const counts = emptyCounts();
		for (const finding of toPost) counts[finding.severity] += 1;

		log(
			`posted ${inline.length} inline / ${unlocatable.length} summary-only, event=${event}`,
		);

		return {
			status: 'success',
			event,
			counts,
			findingsCount: toPost.length,
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
