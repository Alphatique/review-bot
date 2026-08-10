import type { KeyedFinding } from './dedupe';
import { type Language, messages } from './i18n';
import { buildInlineMarker, REVIEW_MARKER } from './marker';
import { SEVERITIES, type Severity } from './schema';

const SEVERITY_EMOJI: Record<Severity, string> = {
	critical: '🔴',
	major: '🟠',
	minor: '🟡',
};

/**
 * インラインコメント 1 件の本文。末尾にマーカーを埋め込む。
 * 本文はモデルが `language` に従って生成済みなので、ここでは固定文言を足さない。
 */
export function renderInlineComment(
	finding: KeyedFinding,
	_lang: Language,
): string {
	const head = `${SEVERITY_EMOJI[finding.severity]} **${finding.severity}** — ${finding.title}`;
	const marker = buildInlineMarker(finding.key, finding.severity);
	return `${head}\n\n${finding.body.trim()}\n\n${marker}\n`;
}

export interface ReviewBodyInput {
	lang: Language;
	/** スレッドとして投稿できた指摘。 */
	posted: readonly KeyedFinding[];
	/** 差分外を指していて破棄した指摘のファイル。 */
	droppedFiles: readonly string[];
	/** コメントの投稿に失敗した指摘のファイル。 */
	failedComments: readonly string[];
	excludedFiles: readonly string[];
	oversizedFiles: readonly string[];
	resolvedCount: number;
}

export function renderReviewBody(input: ReviewBodyInput): string {
	const m = messages(input.lang);
	const lines: string[] = [m.reviewHeading, ''];

	if (input.posted.length === 0) lines.push(m.noFindings, '');
	else {
		lines.push(m.findingsCount(input.posted.length), '');
		lines.push(renderCounts(input.posted), '');
	}

	if (input.resolvedCount > 0) {
		lines.push(m.resolvedCount(input.resolvedCount), '');
	}
	if (input.droppedFiles.length > 0) {
		lines.push(m.droppedNote(input.droppedFiles.map(sanitizePath)), '');
	}
	if (input.failedComments.length > 0) {
		lines.push(m.commentFailedNote(input.failedComments.map(sanitizePath)), '');
	}
	if (input.excludedFiles.length > 0) {
		lines.push(m.excludedNote(input.excludedFiles.map(sanitizePath)), '');
	}
	if (input.oversizedFiles.length > 0) {
		lines.push(m.oversizedWarning(input.oversizedFiles.map(sanitizePath)), '');
	}

	lines.push(REVIEW_MARKER);
	return `${lines.join('\n').trimEnd()}\n`;
}

export function renderFailureBody(errorText: string, lang: Language): string {
	const m = messages(lang);
	return `${[
		m.reviewHeading,
		'',
		m.failureBody,
		'',
		'<details>',
		`<summary>${m.errorDetails}</summary>`,
		'',
		'```',
		sanitizeFenced(errorText.trim()) || '(no details)',
		'```',
		'',
		'</details>',
		'',
		REVIEW_MARKER,
	].join('\n')}\n`;
}

export interface ResolveReplyInput {
	reason: string;
	headSha: string;
	lang: Language;
}

/**
 * resolve の前にスレッドへ返す監査跡。
 * 巻き戻しを自動化しないので、この返信の通知が誤 resolve に気づく唯一の経路になる。
 */
export function renderResolveReply(input: ResolveReplyInput): string {
	const m = messages(input.lang);
	return `${m.resolveReply(
		sanitizeInline(input.headSha).slice(0, 7),
		sanitizeInline(input.reason),
	)}\n`;
}

function renderCounts(findings: readonly KeyedFinding[]): string {
	const parts: string[] = [];
	for (const severity of SEVERITIES) {
		const count = findings.filter(f => f.severity === severity).length;
		if (count > 0) {
			parts.push(`${SEVERITY_EMOJI[severity]} ${severity}: ${count}`);
		}
	}
	return parts.join(' / ');
}

/**
 * Review 本文に到達する文字列はすべてシリアライズ形式への入力である。
 * `<` と `>` を実体参照にすればコメント区切りが成立しなくなり、
 * 偽マーカーを本文に注入できなくなる。表示は変わらない。
 */
function sanitizeInline(text: string): string {
	return text
		.replace(/\s+/gu, ' ')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.trim();
}

/** コードスパンで囲む値（ファイルパス）用。バックティックも潰す。 */
function sanitizePath(text: string): string {
	return sanitizeInline(text).replaceAll('`', '');
}

/** フェンス内に置くエラー本文用。改行は情報なので保つ。 */
function sanitizeFenced(text: string): string {
	return text.replaceAll('<', '&lt;').replaceAll('```', '` ` `');
}
