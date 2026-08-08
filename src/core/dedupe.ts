import { findingKey } from './marker';
import type { Finding, Severity } from './schema';

/** GitHub 上に既に存在する bot の指摘。 */
export interface ExistingFinding {
	key: string;
	severity: Severity;
	isResolved: boolean;
	isOutdated: boolean;
}

export interface KeyedFinding extends Finding {
	key: string;
}

export interface DedupeResult {
	toPost: KeyedFinding[];
	alreadyPosted: KeyedFinding[];
}

/**
 * 新規指摘を既存コメントと突き合わせ、まだ投稿していないものだけを返す。
 * resolve 済み・outdated でも再投稿はしない（人間の判断を蒸し返さない）。
 */
export function dedupe(
	findings: readonly Finding[],
	existing: readonly ExistingFinding[],
): DedupeResult {
	const existingKeys = new Set(existing.map(e => e.key));
	const seen = new Set<string>();

	const toPost: KeyedFinding[] = [];
	const alreadyPosted: KeyedFinding[] = [];

	for (const finding of findings) {
		const key = findingKey(finding.file, finding.title);
		if (seen.has(key)) continue;
		seen.add(key);

		const keyed: KeyedFinding = { ...finding, key };
		if (existingKeys.has(key)) alreadyPosted.push(keyed);
		else toPost.push(keyed);
	}

	return { toPost, alreadyPosted };
}
