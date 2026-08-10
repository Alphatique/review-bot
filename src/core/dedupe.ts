import { findingKey } from './marker';
import type { Finding } from './schema';

export interface KeyedFinding extends Finding {
	key: string;
}

export interface DedupeResult {
	toPost: KeyedFinding[];
}

/**
 * 新規指摘を既存スレッドと突き合わせ、まだ投稿していないものだけを返す。
 * resolve 済み・outdated でも再投稿はしない（人間の判断を蒸し返さない）。
 */
export function dedupe(
	findings: readonly Finding[],
	existing: readonly { key: string }[],
): DedupeResult {
	const existingKeys = new Set(existing.map(e => e.key));
	const seen = new Set<string>();

	const toPost: KeyedFinding[] = [];

	for (const finding of findings) {
		const key = findingKey(finding.file, finding.title);
		if (seen.has(key) || existingKeys.has(key)) continue;
		seen.add(key);
		toPost.push({ ...finding, key });
	}

	return { toPost };
}
