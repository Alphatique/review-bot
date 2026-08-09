import { OWN_VERDICT_STATES, type OwnVerdictState } from './decision';
import { hasReviewMarker, hasStickyMarker } from './marker';

/** GitHub API が返す投稿者。必要な項目だけに絞ってある。 */
export interface Author {
	login?: string;
	type?: string;
}

/**
 * この投稿が自分のものか。
 * login が null なのは GITHUB_TOKEN で identity を確定できなかった場合で、
 * そのときだけ Bot 判定にフォールバックする。
 */
export function isOwnAuthor(
	user: Author | null | undefined,
	login: string | null,
): boolean {
	return login === null ? user?.type === 'Bot' : user?.login === login;
}

export interface OwnVerdict {
	id: number;
	state: OwnVerdictState;
}

export interface ReviewLike {
	id: number;
	state: string;
	body?: string | null;
	user?: Author | null;
}

/**
 * Review 一覧から、GitHub 上で生きている自分の判定を選ぶ。
 * 新しい順に見て最初に見つかったものが現在の判定。
 */
export function selectOwnVerdict(
	reviews: readonly ReviewLike[],
	login: string | null,
): OwnVerdict | null {
	for (let i = reviews.length - 1; i >= 0; i -= 1) {
		const review = reviews[i]!;
		// GITHUB_TOKEN では identity を確定できず Bot 判定に落ちるため、
		// 投稿者判定だけでは他 App の Review と区別できない。マーカーとの
		// AND で絞り、他 App の Review を誤って自分のものと扱わないようにする。
		if (!isOwnAuthor(review.user, login)) continue;
		if (!hasReviewMarker(review.body ?? '')) continue;
		// dismiss された判定より古いものを掘り出してはいけない。GitHub 上では
		// この時点でレビュアーの判定は無効になっており、生きている判定は無い。
		// （読み飛ばして続行すると、dismiss で意図的に外したはずの古い
		// CHANGES_REQUESTED を「生きている」と誤認する。）
		if (review.state === 'DISMISSED') return null;
		// COMMENTED / PENDING は判定を上書きしないので読み飛ばす。
		if (!(OWN_VERDICT_STATES as readonly string[]).includes(review.state)) {
			continue;
		}
		return { id: review.id, state: review.state as OwnVerdictState };
	}
	return null;
}

export interface IssueCommentLike {
	id: number;
	body?: string | null;
	user?: Author | null;
}

/**
 * issue comment 一覧から、この Action の sticky を選ぶ。
 * sticky を騙るコメントを他人が投稿できると reviewed を head まで進められて
 * レビューを丸ごとスキップさせられるため、作成者を必ず確認する。
 */
export function selectSticky(
	comments: readonly IssueCommentLike[],
	login: string | null,
): { commentId: number; body: string } | null {
	for (const comment of comments) {
		const body = comment.body ?? '';
		if (!hasStickyMarker(body)) continue;
		if (!isOwnAuthor(comment.user, login)) continue;
		return { commentId: comment.id, body };
	}
	return null;
}
