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

/** run マーカーの値として許可する文字。`-->` を閉じられない範囲に限定する。 */
const MARKER_VALUE = String.raw`[\w.:@/-]+`;

const STICKY_MARKER_RE = new RegExp(
	String.raw`<!--\s*review-bot:v1 sticky\s+reviewed=(${MARKER_VALUE})\s*-->`,
	'g',
);
const RUN_MARKER_RE = /<!--\s*review-bot:v1 run\s+([^>]*?)\s*-->/g;
const RUN_FIELD_RE = new RegExp(
	String.raw`([a-z]+)=(${MARKER_VALUE})(?=\s|$)`,
	'g',
);
/** `renderInlineComment` が出す 1 行目。ここからタイトルを復元する。 */
const INLINE_TITLE_RE = /\*\*(?:critical|major|minor)\*\*\s+—\s+(.+)$/;

export const RUN_EVENTS = [
	'COMMENT',
	'REQUEST_CHANGES',
	'APPROVE',
	'NONE',
	'FAILED',
] as const;
export type RunEvent = (typeof RUN_EVENTS)[number];

/** 1 回の Action 実行の記録。sticky に 1 行ずつ追記する。 */
export interface RunRecord {
	commit: string;
	mode: 'auto' | 'full';
	newFindings: number;
	event: RunEvent;
	/** 全 attempt の合計。 */
	costUsd: number;
	/** 全 attempt の合計秒数。 */
	seconds: number;
	attempts: number;
	model: string;
	effort: string;
}

export function buildStickyMarker(reviewed: string): string {
	return `<!-- review-bot:v1 sticky reviewed=${reviewed} -->`;
}

export function parseStickyMarker(body: string): { reviewed: string } | null {
	// マーカーは常に本文末尾に付ける。指摘 body に偽マーカーが混ざっても
	// 末尾の正規ブロックが勝つよう、最後の一致を採用する。
	const matches = [...body.matchAll(STICKY_MARKER_RE)];
	const last = matches[matches.length - 1];
	if (!last?.[1]) return null;

	return { reviewed: last[1] };
}

export function hasStickyMarker(body: string): boolean {
	return parseStickyMarker(body) !== null;
}

export function buildRunMarker(run: RunRecord): string {
	const fields = [
		`commit=${run.commit}`,
		`mode=${run.mode}`,
		`new=${run.newFindings}`,
		`event=${run.event}`,
		`cost=${run.costUsd.toFixed(4)}`,
		`sec=${Math.round(run.seconds)}`,
		`attempts=${run.attempts}`,
		`model=${run.model}`,
		`effort=${run.effort}`,
	];
	return `<!-- review-bot:v1 run ${fields.join(' ')} -->`;
}

/**
 * key=value の緩いパース。未知のキーは無視し、欠損キーは既定値で埋める。
 * こうしておけば後からキーを足しても、拡張前に書かれたマーカーがそのまま読める。
 */
export function parseRunMarkers(body: string): RunRecord[] {
	const records: RunRecord[] = [];

	for (const marker of body.matchAll(RUN_MARKER_RE)) {
		const fields = new Map<string, string>();
		for (const field of (marker[1] ?? '').matchAll(RUN_FIELD_RE)) {
			fields.set(field[1]!, field[2]!);
		}

		// commit が読めない行は履歴として意味を成さないので捨てる。
		const commit = fields.get('commit');
		if (!commit) continue;

		const event = fields.get('event');
		records.push({
			commit,
			mode: fields.get('mode') === 'full' ? 'full' : 'auto',
			newFindings: toInt(fields.get('new'), 0),
			event: (RUN_EVENTS as readonly string[]).includes(event ?? '')
				? (event as RunEvent)
				: 'NONE',
			costUsd: toNumber(fields.get('cost'), 0),
			seconds: toInt(fields.get('sec'), 0),
			attempts: toInt(fields.get('attempts'), 1),
			model: fields.get('model') ?? '',
			effort: fields.get('effort') ?? '',
		});
	}

	return records;
}

export function totalCostUsd(runs: readonly RunRecord[]): number {
	return runs.reduce((sum, run) => sum + run.costUsd, 0);
}

/**
 * インラインコメント本文の 1 行目からタイトルを復元する。
 * 書式は renderInlineComment が生成しているので安定する。読めなければ null。
 */
export function parseInlineTitle(body: string): string | null {
	const firstLine = body.split('\n', 1)[0] ?? '';
	const match = INLINE_TITLE_RE.exec(firstLine);
	return match?.[1]?.trim() || null;
}

function toNumber(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function toInt(value: string | undefined, fallback: number): number {
	const parsed = toNumber(value, fallback);
	return Number.isInteger(parsed) ? parsed : fallback;
}
