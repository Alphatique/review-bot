import { hasReviewMarker } from './marker';

export interface ReviewRecord {
	id: number;
	body: string;
	state: string;
}

export interface LiveVerdict {
	/** dismissReview に渡す Review の id。 */
	id: number;
	state: 'APPROVED' | 'CHANGES_REQUESTED';
}

/**
 * 自分が出した Review のうち、GitHub がいま有効としている判定を返す。
 * reviews は古い順（GitHub の既定順）で渡すこと。
 */
export function pickLiveVerdict(
	reviews: readonly ReviewRecord[],
): LiveVerdict | null {
	for (let i = reviews.length - 1; i >= 0; i -= 1) {
		const review = reviews[i]!;
		if (!hasReviewMarker(review.body)) continue;

		// DISMISSED はここで打ち切る。読み飛ばして古い判定を掘り出すと、
		// GitHub がもう有効としていない判定を「生きている」と誤認する。
		if (review.state === 'DISMISSED') return null;
		if (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED') {
			return { id: review.id, state: review.state };
		}
	}
	return null;
}
