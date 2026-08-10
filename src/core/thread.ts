import type { Severity } from './schema';

/**
 * PR 上のレビュースレッド 1 件。この Action が付けた指摘だけを表す。
 * 状態の真実の源はここにしかない。
 */
export interface ThreadInfo {
	/** GraphQL のノード ID。resolveReviewThread に渡す。 */
	id: string;
	/** 先頭コメントの databaseId。返信の投稿に使う。 */
	commentId: number;
	key: string;
	severity: Severity;
	file: string;
	line: number | null;
	/** インラインコメント本文から復元したタイトル。読めなければ null。 */
	title: string | null;
	isResolved: boolean;
	isOutdated: boolean;
}
