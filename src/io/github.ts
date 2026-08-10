import { getOctokit } from '@actions/github';
import type { ReviewEvent } from '../core/decision';
import { parseInlineMarker, parseInlineTitle } from '../core/marker';
import type { ThreadInfo } from '../core/thread';
import type { ReviewRecord } from '../core/verdict';

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
	line: number;
	body: string;
}

export interface CreateReviewInput {
	body: string;
	event: Exclude<ReviewEvent, 'NONE'>;
	commitId: string;
	comments: readonly InlineCommentInput[];
}

export interface GitHubClient {
	getPullRequest(): Promise<PullRequestInfo>;
	getDiff(from: string, to: string): Promise<string>;
	listThreads(): Promise<ThreadInfo[]>;
	createReview(input: CreateReviewInput): Promise<void>;
	/** 自分のものかどうかは判定せず、そのまま古い順に返す。 */
	listReviews(): Promise<ReviewRecord[]>;
	dismissReview(reviewId: number, message: string): Promise<void>;
}

export interface GitHubClientOptions {
	token: string;
	owner: string;
	repo: string;
	prNumber: number;
}

interface ReviewThreadsResponse {
	repository: {
		pullRequest: {
			reviewThreads: {
				pageInfo: { hasNextPage: boolean; endCursor: string | null };
				nodes: {
					id: string;
					isResolved: boolean;
					isOutdated: boolean;
					path: string;
					line: number | null;
					comments: { nodes: { body: string; databaseId: number }[] };
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
					id
					isResolved
					isOutdated
					path
					line
					comments(first: 1) { nodes { body databaseId } }
				}
			}
		}
	}
}`;

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
	const octokit = getOctokit(options.token);
	const { owner, repo, prNumber } = options;

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
						id: thread.id,
						commentId: comment.databaseId,
						key: marker.key,
						severity: marker.severity,
						file: thread.path,
						line: thread.line,
						title: parseInlineTitle(comment.body),
						isResolved: thread.isResolved,
						isOutdated: thread.isOutdated,
					});
				}

				if (!page.pageInfo.hasNextPage) break;
				cursor = page.pageInfo.endCursor;
			}

			return threads;
		},

		async createReview(input) {
			await octokit.rest.pulls.createReview({
				owner,
				repo,
				pull_number: prNumber,
				commit_id: input.commitId,
				body: input.body,
				event: input.event,
				comments: input.comments.map(comment => ({
					path: comment.path,
					line: comment.line,
					side: 'RIGHT',
					body: comment.body,
				})),
			});
		},

		async listReviews() {
			const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
				owner,
				repo,
				pull_number: prNumber,
				per_page: 100,
			});
			return reviews.map(review => ({
				id: review.id,
				body: review.body ?? '',
				state: review.state,
			}));
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
