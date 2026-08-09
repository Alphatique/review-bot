import type { Board, ThreadInfo } from './board';
import type { KeyedFinding } from './dedupe';
import { type Language, type LatestRun, messages } from './i18n';
import {
	buildInlineMarker,
	buildRunMarker,
	buildStickyMarker,
	FAILURE_MARKER,
	type RunRecord,
	SUMMARY_MARKER,
	totalCostUsd,
} from './marker';
import { SEVERITIES, SEVERITY_ORDER, type Severity } from './schema';

const SEVERITY_EMOJI: Record<Severity, string> = {
	critical: '🔴',
	major: '🟠',
	minor: '🟡',
};

const EVENT_LABEL: Record<RunRecord['event'], string | null> = {
	COMMENT: '💬 COMMENT',
	REQUEST_CHANGES: '🔴 REQUEST_CHANGES',
	APPROVE: '✅ APPROVE',
	NONE: null,
	FAILED: null,
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
		FAILURE_MARKER,
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

export interface StickyInput {
	lang: Language;
	board: Board;
	/** 過去分 + 今回分。時系列昇順。 */
	runs: readonly RunRecord[];
	reviewedSha: string;
	/** 実行情報セクションに出す最新実行。差分ゼロで終わった回は null。 */
	latest: LatestRun | null;
	/** 失敗したときのエラー本文。成功時は null。 */
	failure: string | null;
	oversizedFiles: readonly string[];
}

export function renderSticky(input: StickyInput): string {
	const m = messages(input.lang);
	const lines: string[] = [m.heading, ''];

	if (input.failure !== null) {
		lines.push(
			m.failureBanner(input.reviewedSha),
			'>',
			`> <details><summary>${m.errorDetails}</summary>`,
			'>',
			'> ```',
			...(input.failure.trim() || '(no details)')
				.split('\n')
				.map(line => `> ${line}`),
			'> ```',
			'>',
			'> </details>',
			'',
		);
	}

	if (input.oversizedFiles.length > 0) {
		lines.push(m.oversizedWarning(input.oversizedFiles), '');
	}

	lines.push(renderStatusLine(input, m), '');

	if (input.board.outstanding.length > 0) {
		lines.push(m.outstandingHeading, '');
		for (const thread of input.board.outstanding) {
			lines.push(renderThreadLine(thread, m.unknownTitle, m.outdatedSuffix));
		}
		lines.push('');
	}

	if (input.board.resolved.length > 0) {
		lines.push(
			`<details><summary>${m.resolvedSummary(input.board.resolved.length)}</summary>`,
			'',
		);
		for (const thread of input.board.resolved) {
			lines.push(
				renderThreadLine(thread, m.unknownTitle, m.outdatedSuffix, true),
			);
		}
		lines.push('', '</details>', '');
	}

	if (input.runs.length > 0) {
		lines.push(...renderHistory(input.runs, m), '');
	}

	if (input.latest !== null) {
		lines.push(
			`<details><summary>${m.runInfoSummary}</summary>`,
			'',
			m.runInfoLine(input.latest),
			'',
			'</details>',
			'',
		);
	}

	lines.push(buildStickyMarker(input.reviewedSha));
	for (const run of input.runs) lines.push(buildRunMarker(run));

	return `${lines.join('\n').trimEnd()}\n`;
}

function renderStatusLine(
	input: StickyInput,
	m: ReturnType<typeof messages>,
): string {
	const parts = [m.reviewedUpTo(input.reviewedSha)];
	const total = input.board.outstanding.length;

	if (total === 0) {
		parts.push(m.noOutstanding);
		return parts.join(' · ');
	}

	parts.push(m.outstandingCount(total));
	const counts = SEVERITIES.filter(s => input.board.counts[s] > 0).map(
		s => `${SEVERITY_EMOJI[s]} ${input.board.counts[s]}`,
	);
	if (counts.length > 0) parts.push(counts.join(' / '));
	return parts.join(' · ');
}

function renderThreadLine(
	thread: ThreadInfo,
	unknownTitle: string,
	outdatedSuffix: string,
	strike = false,
): string {
	const title = thread.title ?? unknownTitle;
	const link = `[${title}](${thread.url})`;
	const where =
		thread.line === null ? thread.file : `${thread.file}:${thread.line}`;
	const suffix = thread.isOutdated ? ` ${outdatedSuffix}` : '';
	return `- ${SEVERITY_EMOJI[thread.severity]} ${strike ? `~~${link}~~` : link} — \`${where}\`${suffix}`;
}

function renderHistory(
	runs: readonly RunRecord[],
	m: ReturnType<typeof messages>,
): string[] {
	const total = `$${totalCostUsd(runs).toFixed(2)}`;
	const rows = runs.map(run => {
		const range = run.mode === 'full' ? m.modeFull : m.modeIncremental;
		const verdict =
			run.event === 'FAILED' ? m.eventFailed : (EVENT_LABEL[run.event] ?? '—');
		// FAILED / NONE の回は「新規 0 件」ではなく「該当なし」を意味する。
		const newCount =
			run.event === 'FAILED' || run.event === 'NONE'
				? '—'
				: String(run.newFindings);
		return `| \`${run.commit}\` | ${range} | ${newCount} | ${verdict} | $${run.costUsd.toFixed(2)} |`;
	});

	return [
		`<details><summary>${m.historySummary(runs.length, total)}</summary>`,
		'',
		`| ${m.historyColumns.join(' | ')} |`,
		`| ${m.historyColumns.map(() => '---').join(' | ')} |`,
		...rows,
		'',
		'</details>',
	];
}
