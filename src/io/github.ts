import { getOctokit } from '@actions/github';
import type { ReviewEvent } from '../core/decision';
import type { ExistingFinding } from '../core/dedupe';
import {
	hasFailureMarker,
	hasSummaryMarker,
	parseInlineMarker,
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
	line: number;
	body: string;
}

export interface CreateReviewInput {
	body: string;
	event: ReviewEvent;
	commitId: string;
	comments: readonly InlineCommentInput[];
}

export interface GitHubClient {
	getPullRequest(): Promise<PullRequestInfo>;
	/** この Action が前回レビューした commit sha。初回なら null。 */
	getLastReviewedCommit(): Promise<string | null>;
	getDiff(from: string, to: string): Promise<string>;
	listExistingFindings(): Promise<ExistingFinding[]>;
	createReview(input: CreateReviewInput): Promise<void>;
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
					isResolved: boolean;
					isOutdated: boolean;
					comments: { nodes: { body: string }[] };
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
					comments(first: 1) { nodes { body } }
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

		async getLastReviewedCommit() {
			const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
				owner,
				repo,
				pull_number: prNumber,
				per_page: 100,
			});
			for (let i = reviews.length - 1; i >= 0; i -= 1) {
				const review = reviews[i]!;
				const body = review.body ?? '';
				// 失敗通知を起点に採用すると、失敗した範囲が二度とレビューされない。
				if (hasSummaryMarker(body) && !hasFailureMarker(body)) {
					return review.commit_id ?? null;
				}
			}
			return null;
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

		async listExistingFindings() {
			const findings: ExistingFinding[] = [];
			let cursor: string | null = null;

			for (;;) {
				const response: ReviewThreadsResponse = await octokit.graphql(
					REVIEW_THREADS_QUERY,
					{ owner, repo, number: prNumber, cursor },
				);
				const threads = response.repository.pullRequest.reviewThreads;

				for (const thread of threads.nodes) {
					const body = thread.comments.nodes[0]?.body ?? '';
					const marker = parseInlineMarker(body);
					if (!marker) continue;
					findings.push({
						key: marker.key,
						severity: marker.severity,
						isResolved: thread.isResolved,
						isOutdated: thread.isOutdated,
					});
				}

				if (!threads.pageInfo.hasNextPage) break;
				cursor = threads.pageInfo.endCursor;
			}

			return findings;
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
	};
}
