import { getOctokit } from '@actions/github';
import type { ThreadInfo } from '../core/board';
import type { ReviewEvent } from '../core/decision';
import {
	hasReviewMarker,
	hasStickyMarker,
	parseInlineMarker,
	parseInlineTitle,
	REVIEW_MARKER,
} from '../core/marker';

export interface PullRequestInfo {
	baseSha: string;
	headSha: string;
	title: string;
	number: number;
	authorLogin: string;
	isFork: boolean;
	isDraft: boolean;
}

export interface InlineCommentInput {
	path: string;
	/** null なら行ではなくファイル全体へのコメントにする。 */
	line: number | null;
	body: string;
}

export interface CreateReviewInput {
	body: string;
	event: ReviewEvent;
	commitId: string;
	comments: readonly InlineCommentInput[];
}

export interface OwnVerdict {
	id: number;
	state: 'APPROVED' | 'CHANGES_REQUESTED';
}

export interface GitHubClient {
	getPullRequest(): Promise<PullRequestInfo>;
	getDiff(from: string, to: string): Promise<string>;
	listThreads(): Promise<ThreadInfo[]>;
	/** この Action の sticky コメント。無ければ null。 */
	findSticky(): Promise<{ commentId: number; body: string } | null>;
	upsertSticky(input: {
		commentId: number | null;
		body: string;
	}): Promise<void>;
	createReview(input: CreateReviewInput): Promise<void>;
	/** GitHub 上で生きている自分の判定。無ければ null。 */
	getOwnVerdict(): Promise<OwnVerdict | null>;
	dismissReview(reviewId: number, message: string): Promise<void>;
}

export interface GitHubClientOptions {
	token: string;
	owner: string;
	repo: string;
	prNumber: number;
	/** 失敗しても続行する操作の記録先。 */
	log: (message: string) => void;
}

interface ReviewThreadsResponse {
	repository: {
		pullRequest: {
			reviewThreads: {
				pageInfo: { hasNextPage: boolean; endCursor: string | null };
				nodes: {
					isResolved: boolean;
					isOutdated: boolean;
					path: string;
					line: number | null;
					comments: { nodes: { body: string; url: string }[] };
				}[];
			};
		};
	};
}

const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
	repository(owner: $owner, name: $repo) {
		pullRequest(number: $number) {
			reviewThreads(first: 100, after: $cursor) {
				pageInfo { hasNextPage endCursor }
				nodes {
					isResolved
					isOutdated
					path
					line
					comments(first: 1) { nodes { body url } }
				}
			}
		}
	}
}`;

/**
 * Octokit のエラーは REST の失敗時 `status` に HTTP ステータスコードを持つ。
 * GITHUB_TOKEN（インストールトークン）で getAuthenticated を叩いたときに
 * 返るのがこの形に限られる。
 */
function isNotFoundOrForbidden(error: unknown): boolean {
	const status = (error as { status?: unknown } | null | undefined)?.status;
	return status === 403 || status === 404;
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
	const octokit = getOctokit(options.token);
	const { owner, repo, prNumber } = options;

	/**
	 * このトークンが名乗る identity。sticky を騙るコメントを他人が投稿できると
	 * reviewed を head まで進められてレビューを丸ごとスキップさせられるため、
	 * 作成者を必ず確認する。GITHUB_TOKEN では getAuthenticated が 403/404 に
	 * なるので、その場合だけ Bot 判定にフォールバックする。
	 */
	let selfLogin: string | null | undefined;
	const resolveSelfLogin = async (): Promise<string | null> => {
		if (selfLogin !== undefined) return selfLogin;
		try {
			const { data } = await octokit.rest.users.getAuthenticated();
			selfLogin = data.login;
		} catch (error) {
			// GITHUB_TOKEN（インストールトークン）は getAuthenticated が 403/404
			// になる、というのが Bot 判定へのフォールバックを許してよい唯一の形。
			// それ以外（rate limit や 5xx などの一時的な障害）を「identity 無し」
			// と誤認すると、PAT 運用で sticky を見失い、findSticky が既存の
			// sticky を見つけられず二重にコメントを作ってしまう。呼び出し元
			// （findSticky / getOwnVerdict）に投げ返し、失敗として扱わせる。
			if (!isNotFoundOrForbidden(error)) throw error;
			options.log(
				`could not resolve the token identity, falling back to bot detection: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			selfLogin = null;
		}
		return selfLogin;
	};

	const isOwnComment = (
		user: { login?: string; type?: string } | null | undefined,
		login: string | null,
	): boolean => (login === null ? user?.type === 'Bot' : user?.login === login);

	return {
		async getPullRequest() {
			const { data } = await octokit.rest.pulls.get({
				owner,
				repo,
				pull_number: prNumber,
			});
			return {
				baseSha: data.base.sha,
				headSha: data.head.sha,
				title: data.title,
				number: data.number,
				authorLogin: data.user?.login ?? '',
				isFork: data.head.repo?.full_name !== `${owner}/${repo}`,
				isDraft: data.draft ?? false,
			};
		},

		async getDiff(from, to) {
			const response = await octokit.rest.repos.compareCommitsWithBasehead({
				owner,
				repo,
				basehead: `${from}...${to}`,
				mediaType: { format: 'diff' },
			});
			// mediaType: diff のとき data は文字列になる。
			return response.data as unknown as string;
		},

		async listThreads() {
			const threads: ThreadInfo[] = [];
			let cursor: string | null = null;

			for (;;) {
				const response: ReviewThreadsResponse = await octokit.graphql(
					REVIEW_THREADS_QUERY,
					{ owner, repo, number: prNumber, cursor },
				);
				const page = response.repository.pullRequest.reviewThreads;

				for (const thread of page.nodes) {
					const comment = thread.comments.nodes[0];
					if (!comment) continue;
					const marker = parseInlineMarker(comment.body);
					if (!marker) continue;
					threads.push({
						key: marker.key,
						severity: marker.severity,
						title: parseInlineTitle(comment.body),
						file: thread.path,
						line: thread.line,
						url: comment.url,
						isResolved: thread.isResolved,
						isOutdated: thread.isOutdated,
					});
				}

				if (!page.pageInfo.hasNextPage) break;
				cursor = page.pageInfo.endCursor;
			}

			return threads;
		},

		async findSticky() {
			const login = await resolveSelfLogin();
			const comments = await octokit.paginate(
				octokit.rest.issues.listComments,
				{
					owner,
					repo,
					issue_number: prNumber,
					per_page: 100,
				},
			);

			for (const comment of comments) {
				const body = comment.body ?? '';
				if (!hasStickyMarker(body)) continue;
				if (!isOwnComment(comment.user, login)) continue;
				return { commentId: comment.id, body };
			}
			return null;
		},

		async upsertSticky({ commentId, body }) {
			if (commentId === null) {
				await octokit.rest.issues.createComment({
					owner,
					repo,
					issue_number: prNumber,
					body,
				});
				return;
			}
			await octokit.rest.issues.updateComment({
				owner,
				repo,
				comment_id: commentId,
				body,
			});
		},

		async createReview(input) {
			const inline = input.comments.filter(c => c.line !== null);
			const fileLevel = input.comments.filter(c => c.line === null);

			await octokit.rest.pulls.createReview({
				owner,
				repo,
				pull_number: prNumber,
				commit_id: input.commitId,
				// getOwnVerdict が「自分の Review」を識別できるよう、
				// 投稿者判定だけに頼らずマーカーも埋め込む。
				body: `${input.body.trimEnd()}\n\n${REVIEW_MARKER}\n`,
				event: input.event,
				comments: inline.map(comment => ({
					path: comment.path,
					line: comment.line as number,
					side: 'RIGHT' as const,
					body: comment.body,
				})),
			});

			// createReview の comments[] は subject_type を受け付けないため、
			// ファイル単位コメントだけは個別に投稿する。
			for (const comment of fileLevel) {
				try {
					await octokit.rest.pulls.createReviewComment({
						owner,
						repo,
						pull_number: prNumber,
						commit_id: input.commitId,
						path: comment.path,
						body: comment.body,
						subject_type: 'file',
					});
				} catch (error) {
					// 1 件の失敗でレビュー全体を落とさない。Review 本文と
					// インラインコメントは既に投稿済みで、やり直すと二重になる。
					options.log(
						`could not post a file-level comment on ${comment.path}: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}
		},

		async getOwnVerdict() {
			const login = await resolveSelfLogin();
			const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
				owner,
				repo,
				pull_number: prNumber,
				per_page: 100,
			});

			for (let i = reviews.length - 1; i >= 0; i -= 1) {
				const review = reviews[i]!;
				// GITHUB_TOKEN では identity を確定できず Bot 判定に落ちるため、
				// 投稿者判定だけでは他 App の Review と区別できない。マーカーとの
				// AND で絞り、他 App の Review を誤って自分のものと扱わないように
				// する。
				if (!isOwnComment(review.user, login)) continue;
				if (!hasReviewMarker(review.body ?? '')) continue;
				// dismiss された判定より古いものを掘り出してはいけない。GitHub 上では
				// この時点でレビュアーの判定は無効になっており、生きている判定は無い。
				// （読み飛ばして続行すると、dismiss で意図的に外したはずの古い
				// CHANGES_REQUESTED を「生きている」と誤認する。）
				if (review.state === 'DISMISSED') return null;
				// COMMENTED / PENDING は判定を上書きしないので読み飛ばす。
				if (
					review.state !== 'APPROVED' &&
					review.state !== 'CHANGES_REQUESTED'
				) {
					continue;
				}
				return { id: review.id, state: review.state };
			}
			return null;
		},

		async dismissReview(reviewId, message) {
			await octokit.rest.pulls.dismissReview({
				owner,
				repo,
				pull_number: prNumber,
				review_id: reviewId,
				message,
			});
		},
	};
}
