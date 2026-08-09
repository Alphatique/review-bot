import { SEVERITY_ORDER, type Severity } from './schema';

/** GitHub 上に存在する bot の指摘スレッド 1 件。 */
export interface ThreadInfo {
	key: string;
	severity: Severity;
	/** インラインコメント本文から復元したタイトル。読めなければ null。 */
	title: string | null;
	file: string;
	line: number | null;
	url: string;
	isResolved: boolean;
	isOutdated: boolean;
}

/** PR 全体の指摘の現在状態を、表示順に整理したもの。 */
export interface Board {
	outstanding: ThreadInfo[];
	resolved: ThreadInfo[];
	/** outstanding のみを数える。 */
	counts: Record<Severity, number>;
}

export function buildBoard(threads: readonly ThreadInfo[]): Board {
	const outstanding = sortForDisplay(threads.filter(t => !t.isResolved));
	const resolved = sortForDisplay(threads.filter(t => t.isResolved));

	const counts: Record<Severity, number> = { critical: 0, major: 0, minor: 0 };
	for (const thread of outstanding) counts[thread.severity] += 1;

	return { outstanding, resolved, counts };
}

function sortForDisplay(threads: readonly ThreadInfo[]): ThreadInfo[] {
	return [...threads].toSorted((a, b) => {
		const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
		if (bySeverity !== 0) return bySeverity;
		const byFile = a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
		if (byFile !== 0) return byFile;
		return (a.line ?? 0) - (b.line ?? 0);
	});
}
