import { createHash } from 'node:crypto';
import { SEVERITIES, type Severity } from './schema';

/**
 * この Action が出した Review だと識別するマーカー。絶対に変更しない。
 * v1 では増分レビューの起点探索に使っていたが、v2 では「自分の Review を
 * identity API 無しで見つける」ために使う。
 */
export const REVIEW_MARKER = '<!-- review-bot:v1 summary -->';

const INLINE_MARKER_RE =
	/<!--\s*review-bot:v1 key=([0-9a-f]{12}) sev=([a-z]+)\s*-->/g;

// renderInlineComment が出す 1 行目。書式はこちらで生成しているので安定する。
const INLINE_TITLE_RE = /^\S+\s+\*\*(?:critical|major|minor)\*\*\s+—\s+(.+)$/;

/**
 * インラインコメント本文の 1 行目からタイトルを復元する。
 * タイトルはマーカーに埋めない。任意の文字が入りうるためエンコードが必要になり、
 * マーカーが識別子以上のものになってしまう。
 */
export function parseInlineTitle(body: string): string | null {
	const firstLine = body.split('\n', 1)[0] ?? '';
	const match = INLINE_TITLE_RE.exec(firstLine.trim());
	return match?.[1]?.trim() || null;
}

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

export function hasReviewMarker(body: string): boolean {
	return body.includes(REVIEW_MARKER);
}
