import type { KeyedFinding } from './dedupe';
import { type Language, messages } from './i18n';
import { buildInlineMarker, SUMMARY_MARKER } from './marker';
import { SEVERITIES, SEVERITY_ORDER, type Severity } from './schema';

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

export interface SummaryInput {
	lang: Language;
	/** インラインコメントとして投稿する指摘。 */
	posted: readonly KeyedFinding[];
	/** 行を特定できずサマリに落とした指摘。 */
	unlocatable: readonly KeyedFinding[];
	excludedFiles: readonly string[];
	oversizedFiles: readonly string[];
	mode: 'auto' | 'full';
}

export function renderSummary(input: SummaryInput): string {
	const m = messages(input.lang);
	const lines: string[] = [m.summaryHeading, ''];

	lines.push(input.mode === 'full' ? m.fullNote : m.incrementalNote, '');

	const total = input.posted.length + input.unlocatable.length;
	if (total === 0) {
		lines.push(m.noFindings, '');
	} else {
		lines.push(m.findingsCount(total), '');
		lines.push(renderCounts([...input.posted, ...input.unlocatable]), '');
	}

	if (input.unlocatable.length > 0) {
		lines.push(m.unlocatableHeading, '', m.unlocatableNote, '');
		for (const finding of sortBySeverity(input.unlocatable)) {
			const where =
				finding.line === null
					? finding.file
					: `${finding.file}:${finding.line}`;
			lines.push(
				`- ${SEVERITY_EMOJI[finding.severity]} **${finding.severity}** \`${where}\` — ${finding.title}`,
				`  ${finding.body.trim().replace(/\n/g, '\n  ')}`,
				'',
			);
		}
	}

	if (input.oversizedFiles.length > 0) {
		lines.push(m.oversizedWarning(input.oversizedFiles), '');
	}

	lines.push(SUMMARY_MARKER);
	return `${lines.join('\n').trimEnd()}\n`;
}

export function renderFailureSummary(
	errorText: string,
	lang: Language,
): string {
	const m = messages(lang);
	return `${[
		m.failureHeading,
		'',
		m.failureBody,
		'',
		'<details>',
		`<summary>${m.errorDetails}</summary>`,
		'',
		'```',
		errorText.trim() || '(no details)',
		'```',
		'',
		'</details>',
		'',
		SUMMARY_MARKER,
	].join('\n')}\n`;
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

function sortBySeverity(findings: readonly KeyedFinding[]): KeyedFinding[] {
	return [...findings].toSorted(
		(a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
	);
}
