import type { Config } from './config';
import { decideEvent, type ReviewEvent } from './core/decision';
import { dedupe, type KeyedFinding } from './core/dedupe';
import { analyzeDiff, isCommentable } from './core/diff';
import { buildPrompt, DEFAULT_INSTRUCTIONS } from './core/prompt';
import {
	renderFailureBody,
	renderInlineComment,
	renderResolveReply,
	renderReviewBody,
} from './core/render';
import { planResolutions } from './core/resolution';
import type { Severity } from './core/schema';
import { type LiveVerdict, pickLiveVerdict } from './core/verdict';
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
	resolvedCount: number;
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
		resolvedCount: 0,
		incompleteFiles: 0,
		error,
	});

	const failure = async (
		error: string,
		liveVerdict: LiveVerdict | null,
	): Promise<RunResult> => {
		log(`review failed: ${error}`);

		// 承認済みのまま失敗すると PR が緑に見える。fail-on-error は job を
		// 落とすが、PR に付いた承認は消えない。
		if (liveVerdict?.state === 'APPROVED') {
			try {
				await github.dismissReview(
					liveVerdict.id,
					'The automated review could not be completed.',
				);
			} catch (dismissError) {
				log(`could not dismiss own approval: ${describe(dismissError)}`);
			}
		}

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
		return failure(`could not fetch pull request: ${describe(error)}`, null);
	}

	if (pr.isFork) {
		// fork PR では GITHUB_TOKEN が read-only になり投稿できない。
		// 失敗通知すら投稿できないので createReview を試みない。
		const error =
			'this pull request comes from a fork; GITHUB_TOKEN is read-only and the review cannot be posted';
		log(error);
		return aborted(error);
	}

	let liveVerdict: LiveVerdict | null = null;

	try {
		log(`reviewing ${pr.baseSha}...${pr.headSha}`);

		// listReviews は失敗を [] に握りつぶすので他より先に呼んでも安全。
		// getDiff / listThreads がここより後で失敗しても、liveVerdict が
		// 既に分かっていれば catch 側の failure() が承認を取り下げられる。
		const reviews = await github.listReviews().catch(error => {
			// 判定を出し直す側に倒れる。通知が増えるだけで安全側。
			log(`could not list reviews: ${describe(error)}`);
			return [];
		});
		liveVerdict = pickLiveVerdict(reviews);

		const rawDiff = await github.getDiff(pr.baseSha, pr.headSha);
		const analysis = analyzeDiff(rawDiff, {
			exclude: config.exclude,
			maxBytes: config.diffMaxBytes,
		});

		const existing = await github.listThreads();

		const inline: InlineCommentInput[] = [];
		/** スレッドが立った指摘。 */
		const tracked: KeyedFinding[] = [];
		/** 投稿に失敗し、スレッドにならなかった指摘。 */
		const untracked: KeyedFinding[] = [];
		/** 差分外を指していて破棄した指摘。 */
		const dropped: KeyedFinding[] = [];
		const resolvedKeys = new Set<string>();

		// 差分が空でもスレッドの現状からは判定が出る。エージェントを呼ばないので
		// 追加コストは無い。
		const emptyDiff = analysis.text.trim() === '';
		if (emptyDiff) log('no reviewable changes; deciding from thread state');

		if (!emptyDiff) {
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
				outstanding: config.autoResolve
					? existing.filter(t => !t.isResolved)
					: [],
				resolvedThreads: existing.filter(t => t.isResolved),
				autoResolve: config.autoResolve,
			});

			let outcome: AgentOutcome = { ok: false, error: 'not attempted' };
			for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
				log(`agent attempt ${attempt}/${config.maxRetries}`);
				outcome = await deps.runAgent({ prompt });
				if (outcome.ok) break;
				log(`attempt ${attempt} failed: ${outcome.error}`);
			}
			if (!outcome.ok) return failure(outcome.error, liveVerdict);

			const { toPost } = dedupe(outcome.findings, existing);

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

			if (config.autoResolve && outcome.resolved.length > 0) {
				const plan = planResolutions({
					threads: existing,
					resolved: outcome.resolved,
				});
				if (plan.ignored.length > 0) {
					log(`ignored unknown resolve keys: ${plan.ignored.join(', ')}`);
				}

				for (const { thread, reason } of plan.toResolve) {
					try {
						// 返信が先。理由の残らない resolve は誰も検証できず、
						// 巻き戻しを自動化しない以上この通知が唯一の気づく経路になる。
						await github.replyToThread({
							commentId: thread.commentId,
							body: renderResolveReply({
								reason,
								headSha: pr.headSha,
								lang: config.language,
							}),
						});
					} catch (error) {
						log(`could not reply to ${thread.key}: ${describe(error)}`);
						continue;
					}
					try {
						await github.resolveThread(thread.id);
						resolvedKeys.add(thread.key);
					} catch (error) {
						log(`could not resolve ${thread.key}: ${describe(error)}`);
					}
				}
			}
		}

		const outstanding: Severity[] = [
			...existing
				.filter(t => !t.isResolved && !resolvedKeys.has(t.key))
				.map(t => t.severity),
			...tracked.map(f => f.severity),
			// 投稿できなくても問題は実在するので未解決として数える。
			...untracked.map(f => f.severity),
		];

		const event = decideEvent({
			outstanding,
			blockOn: config.blockOn,
			approve: config.approve,
			// サイズ超過で読めなかったファイルも、承認の根拠にならない点は
			// dropped / untracked と同じ。除外設定 (excludedFiles) は意図的に
			// 読まないファイルなので含めない。
			hasUntrackedFindings:
				dropped.length > 0 ||
				untracked.length > 0 ||
				analysis.oversizedFiles.length > 0,
			canSubmitVerdict: !pr.authorLogin.endsWith(BOT_AUTHOR_SUFFIX),
			liveVerdict,
			hasSomethingToReport:
				tracked.length > 0 || untracked.length > 0 || dropped.length > 0,
		});

		if (event !== 'NONE') {
			await github.createReview({
				body: renderReviewBody({
					lang: config.language,
					posted: tracked,
					droppedFiles: dropped.map(f => f.file),
					failedComments: untracked.map(f => f.file),
					excludedFiles: analysis.excludedFiles,
					oversizedFiles: analysis.oversizedFiles,
					resolvedCount: resolvedKeys.size,
				}),
				event,
				commitId: pr.headSha,
				comments: inline,
			});
		}

		const counts = emptyCounts();
		for (const finding of tracked) counts[finding.severity] += 1;

		log(
			`tracked ${tracked.length} / untracked ${untracked.length} / dropped ${dropped.length} / resolved ${resolvedKeys.size}, event=${event}`,
		);

		return {
			status: 'success',
			event,
			counts,
			findingsCount: tracked.length,
			resolvedCount: resolvedKeys.size,
			incompleteFiles: analysis.oversizedFiles.length,
			error: null,
		};
	} catch (error) {
		return failure(describe(error), liveVerdict);
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
