import type { Board, ThreadInfo } from './board';
import type { KeyedFinding } from './dedupe';
import { type Language, type LatestRun, messages } from './i18n';
import {
	buildInlineMarker,
	buildRunMarker,
	buildStickyMarker,
	type RunRecord,
	totalCostUsd,
} from './marker';
import { SEVERITIES, type Severity } from './schema';

const SEVERITY_EMOJI: Record<Severity, string> = {
	critical: '🔴',
	major: '🟠',
	minor: '🟡',
};

/**
 * 表示専用の短縮。マーカーの reviewed= / commit= は state そのものなので
 * ここでは触らない — 短縮した値を書いてしまうと getDiff の呼び出しに
 * 使う commit が変わってしまう。
 */
function shortSha(sha: string): string {
	return sha.slice(0, 7);
}

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
 * 1 行目の書式は parseInlineTitle が読むので変更しない。
 */
export function renderInlineComment(
	finding: KeyedFinding,
	_lang: Language,
): string {
	const head = `${SEVERITY_EMOJI[finding.severity]} **${finding.severity}** — ${finding.title}`;
	const marker = buildInlineMarker(finding.key, finding.severity);
	return `${head}\n\n${finding.body.trim()}\n\n${marker}\n`;
}

export interface StickyInput {
	lang: Language;
	board: Board;
	/** 過去分 + 今回分。時系列昇順。 */
	runs: readonly RunRecord[];
	reviewedSha: string;
	/** 実行情報セクションに出す最新実行。差分ゼロで終わった回は null。 */
	latest: LatestRun | null;
	/** 失敗したときのエラー本文と、レビューできなかった commit。成功時は null。 */
	failure: { message: string; sha: string } | null;
	oversizedFiles: readonly string[];
	/** 差分に無いファイルを狙っていたため破棄した指摘のファイル名。重複排除済み。 */
	droppedFiles: readonly string[];
}

export function renderSticky(input: StickyInput): string {
	const m = messages(input.lang);
	const lines: string[] = [m.heading, ''];

	if (input.failure !== null) {
		lines.push(
			// reviewedSha は「最後に成功したレビュー地点」であり、今回失敗した
			// commit ではない。バナーは今回未レビューになった commit を名指しする。
			m.failureBanner(input.failure.sha),
			'>',
			`> <details><summary>${m.errorDetails}</summary>`,
			'>',
			'> ```',
			...(sanitizeFenced(input.failure.message).trim() || '(no details)')
				.split('\n')
				.map(line => `> ${line}`),
			'> ```',
			'>',
			'> </details>',
			'',
		);
	}

	if (input.oversizedFiles.length > 0) {
		lines.push(
			m.oversizedWarning(input.oversizedFiles.map(sanitizeInline)),
			'',
		);
	}

	if (input.droppedFiles.length > 0) {
		lines.push(m.droppedWarning(input.droppedFiles.map(sanitizeInline)), '');
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
	const parts = [m.reviewedUpTo(shortSha(input.reviewedSha))];
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

/**
 * sticky に埋め込む前に潰す。sticky は状態ストアそのものなので、ここに来る
 * 文字列は「表示テキスト」ではなく「シリアライズ形式への入力」として扱う。
 * < と > を実体参照にするのは、表示を変えずに <!-- --> を成立させないため。
 * バックティックはコードスパンを閉じられるので潰す。
 */
function sanitizeInline(value: string): string {
	return value
		.replace(/\s+/g, ' ')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/`/g, "'")
		.trim();
}

/**
 * フェンス内に出すテキスト。改行は情報なので保つ。マーカーは <!-- が
 * 成立しなければ作れないので < だけを潰し、フェンス自体を閉じられないようにする。
 */
function sanitizeFenced(value: string): string {
	return value.replace(/</g, '&lt;').replace(/```/g, "'''");
}

/**
 * タイトルはモデル出力で、差分の内容に影響される。sticky は編集され続ける
 * 常設コメントなので、リンクラベルを閉じられたり、偽のマーカーを仕込まれたり
 * すると壊れたまま残る。埋め込む直前に潰す。角括弧はリンクラベルの中でのみ
 * 問題になるので、共通の sanitizeInline とは別にここでだけエスケープする。
 */
function sanitizeTitle(title: string): string {
	return sanitizeInline(title).replace(/([\\[\]])/g, String.raw`\$1`);
}

function renderThreadLine(
	thread: ThreadInfo,
	unknownTitle: string,
	outdatedSuffix: string,
	strike = false,
): string {
	const title = sanitizeTitle(thread.title ?? unknownTitle);
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
		return `| \`${shortSha(run.commit)}\` | ${range} | ${newCount} | ${verdict} | $${run.costUsd.toFixed(2)} |`;
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
