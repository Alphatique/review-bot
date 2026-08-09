export const LANGUAGES = ['en', 'ja'] as const;
export type Language = (typeof LANGUAGES)[number];

/** 実行情報セクションに出す最新実行の値。 */
export interface LatestRun {
	model: string;
	effort: string;
	seconds: number;
	costUsd: number;
	attempts: number;
}

export interface Messages {
	// renderSummary / renderFailureSummary（旧）が参照する。Task 8 で renderSticky に
	// 一本化した後、oversizedWarning / errorDetails を除いて一緒に消す。
	summaryHeading: string;
	noFindings: string;
	findingsCount: (n: number) => string;
	incrementalNote: string;
	fullNote: string;
	unlocatableHeading: string;
	unlocatableNote: string;
	failureHeading: string;
	failureBody: string;
	instructionSource: string;

	// renderSticky（新）が参照する。
	heading: string;
	reviewedUpTo: (sha: string) => string;
	outstandingCount: (n: number) => string;
	noOutstanding: string;
	outstandingHeading: string;
	resolvedSummary: (n: number) => string;
	historySummary: (runs: number, totalCost: string) => string;
	historyColumns: readonly [string, string, string, string, string];
	modeIncremental: string;
	modeFull: string;
	eventFailed: string;
	runInfoSummary: string;
	runInfoLine: (latest: LatestRun) => string;
	failureBanner: (sha: string) => string;
	outdatedSuffix: string;
	unknownTitle: string;

	// 新旧で共用。重複させない。
	errorDetails: string;
	oversizedWarning: (files: readonly string[]) => string;
}

const EN: Messages = {
	summaryHeading: '## 🤖 Code Review',
	noFindings: 'No new findings.',
	findingsCount: n => `${n} new finding${n === 1 ? '' : 's'} posted inline.`,
	incrementalNote: 'Reviewed the changes since the last review.',
	fullNote: 'Reviewed the full diff of this pull request.',
	unlocatableHeading: '### Findings without a diff location',
	unlocatableNote:
		'These could not be anchored to a line in the diff, so they are listed here.',
	failureHeading: '## 🤖 Code Review',
	failureBody:
		'⚠️ The automated review could not be completed. Re-run the workflow or check the job logs.',
	instructionSource: 'Review instructions',

	heading: '## 🤖 Code Review',
	reviewedUpTo: sha => `Reviewed up to \`${sha}\``,
	outstandingCount: n => `**${n}** outstanding`,
	noOutstanding: 'no outstanding findings',
	outstandingHeading: '### Outstanding findings',
	resolvedSummary: n => `Resolved (${n})`,
	historySummary: (runs, totalCost) =>
		`Review history (${runs} run${runs === 1 ? '' : 's'} · ${totalCost} total)`,
	historyColumns: ['commit', 'range', 'new', 'verdict', 'cost'],
	modeIncremental: 'incremental',
	modeFull: 'full',
	eventFailed: '⚠️ failed',
	runInfoSummary: 'Run details',
	runInfoLine: latest =>
		`This run: \`${latest.model}\` · effort \`${latest.effort}\` · ${latest.seconds}s · $${latest.costUsd.toFixed(2)}${
			latest.attempts > 1 ? ` (succeeded on attempt ${latest.attempts})` : ''
		}`,
	failureBanner: sha =>
		`> ⚠️ The automated review could not be completed. \`${sha}\` has **not** been reviewed. Re-run the workflow or check the job logs.`,
	outdatedSuffix: '(outdated)',
	unknownTitle: '(title unavailable)',

	errorDetails: 'Error details',
	oversizedWarning: files =>
		`> ⚠️ ${files.length} file(s) were skipped because the diff exceeded the size limit and were **not reviewed**: ${files
			.map(f => `\`${f}\``)
			.join(', ')}`,
};

const JA: Messages = {
	summaryHeading: '## 🤖 コードレビュー',
	noFindings: '新規の指摘はありません。',
	findingsCount: n =>
		`${n} 件の新規指摘をインラインコメントとして投稿しました。`,
	incrementalNote: '前回のレビュー以降の変更をレビューしました。',
	fullNote: 'この PR の差分全体をレビューしました。',
	unlocatableHeading: '### 行を特定できなかった指摘',
	unlocatableNote:
		'差分内の行に紐づけられなかったため、ここにまとめて記載します。',
	failureHeading: '## 🤖 コードレビュー',
	failureBody:
		'⚠️ 自動レビューを完了できませんでした。ワークフローを再実行するか、ジョブのログを確認してください。',
	instructionSource: 'レビュー観点',

	heading: '## 🤖 コードレビュー',
	reviewedUpTo: sha => `\`${sha}\` までレビュー済み`,
	outstandingCount: n => `未解決 **${n}** 件`,
	noOutstanding: '未解決の指摘はありません',
	outstandingHeading: '### 未解決の指摘',
	resolvedSummary: n => `解決済み (${n})`,
	historySummary: (runs, totalCost) =>
		`レビュー履歴 (${runs} 回 · 合計 ${totalCost})`,
	historyColumns: ['commit', '範囲', '新規', '判定', 'コスト'],
	modeIncremental: '増分',
	modeFull: '全体',
	eventFailed: '⚠️ 失敗',
	runInfoSummary: '実行情報',
	runInfoLine: latest =>
		`今回: \`${latest.model}\` · effort \`${latest.effort}\` · ${latest.seconds}s · $${latest.costUsd.toFixed(2)}${
			latest.attempts > 1 ? `（${latest.attempts} 回目で成功）` : ''
		}`,
	failureBanner: sha =>
		`> ⚠️ 自動レビューを完了できませんでした。\`${sha}\` は未レビューです。ワークフローを再実行するか、ジョブのログを確認してください。`,
	outdatedSuffix: '(outdated)',
	unknownTitle: '(タイトル不明)',

	errorDetails: 'エラー概要',
	oversizedWarning: files =>
		`> ⚠️ 差分がサイズ上限を超えたため ${files.length} 件のファイルを**レビューしていません**: ${files
			.map(f => `\`${f}\``)
			.join(', ')}`,
};

export function messages(lang: Language): Messages {
	return lang === 'ja' ? JA : EN;
}
