import { createHash } from 'node:crypto';
import { SEVERITIES, type Severity } from './schema';

/** レビュー本文がこの Action のものだと識別するマーカー。絶対に変更しない。 */
export const SUMMARY_MARKER = '<!-- review-bot:v1 summary -->';

/**
 * レビューを完了できなかったときの通知に付けるマーカー。
 * これが付いたレビューを「前回レビュー地点」に採用すると、失敗した範囲が
 * 二度とレビューされないまま緑になるため、増分の起点から除外する。
 */
export const FAILURE_MARKER = '<!-- review-bot:v1 failure -->';

const INLINE_MARKER_RE =
	/<!--\s*review-bot:v1 key=([0-9a-f]{12}) sev=([a-z]+)\s*-->/g;

/**
 * 指摘の同一性キー。行番号を含めないので、後続コミットで行がずれても
 * 同じ指摘だと判定できる。
 */
export function findingKey(file: string, title: string): string {
	const normalized = title
		.trim()
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.replace(/[.。、,!！?？:：;；]+$/u, '');
	return createHash('sha256')
		.update(`${file}:${normalized}`, 'utf8')
		.digest('hex')
		.slice(0, 12);
}

export function buildInlineMarker(key: string, severity: Severity): string {
	return `<!-- review-bot:v1 key=${key} sev=${severity} -->`;
}

export function parseInlineMarker(
	body: string,
): { key: string; severity: Severity } | null {
	// マーカーは常に本文末尾に付ける。指摘 body に偽マーカーが混ざっても
	// 末尾の正規ブロックが勝つよう、最後の一致を採用する。
	const matches = [...body.matchAll(INLINE_MARKER_RE)];
	const last = matches[matches.length - 1];
	if (!last) return null;

	const key = last[1]!;
	const severity = last[2]!;
	if (!(SEVERITIES as readonly string[]).includes(severity)) return null;

	return { key, severity: severity as Severity };
}

export function hasSummaryMarker(body: string): boolean {
	return body.includes(SUMMARY_MARKER);
}

export function hasFailureMarker(body: string): boolean {
	return body.includes(FAILURE_MARKER);
}
