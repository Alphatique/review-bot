export const LANGUAGES = ['en', 'ja'] as const;
export type Language = (typeof LANGUAGES)[number];

/** 実行情報セクションに出す最新実行の値。 */
export interface LatestRun {
	model: string;
	effort: string;
	seconds: number;
	costUsd: number;
	attempts: number;
	/**
	 * この実行が最終的に成功したか。false のとき attempts > 1 は
	 * 「リトライを使い切った」ことを意味するので、runInfoLine は
	 * 「N 回目で成功」ではなく「N 回試行」と表示を変える。
	 */
	succeeded: boolean;
}

export interface Messages {
	// renderSticky が参照する。
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
	/** createReview の body。指摘そのものは sticky にまとまるので、リンクの案内だけ出す。 */
	reviewPointer: string;

	errorDetails: string;
	oversizedWarning: (files: readonly string[]) => string;
	/** 差分に無いファイルへの指摘を破棄したときの警告。 */
	droppedWarning: (files: readonly string[]) => string;
}

/**
 * attempts === 1 なら何回試したかは自明なので付けない。attempts > 1 のとき、
 * 成功したのか（succeeded）失敗したのかで意味が逆になる。「3 回目で成功」を
 * 失敗した実行に出すと、直後の失敗バナーと矛盾したまま読める。
 */
function attemptSuffixEn(latest: LatestRun): string {
	if (latest.attempts <= 1) return '';
	return latest.succeeded
		? ` (succeeded on attempt ${latest.attempts})`
		: ` (${latest.attempts} attempts)`;
}

function attemptSuffixJa(latest: LatestRun): string {
	if (latest.attempts <= 1) return '';
	return latest.succeeded
		? `（${latest.attempts} 回目で成功）`
		: `（${latest.attempts} 回試行）`;
}

const EN: Messages = {
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
		`This run: \`${latest.model}\` · effort \`${latest.effort}\` · ${latest.seconds}s · $${latest.costUsd.toFixed(2)}${attemptSuffixEn(latest)}`,
	failureBanner: sha =>
		`> ⚠️ The automated review could not be completed. \`${sha}\` has **not** been reviewed. Re-run the workflow or check the job logs.`,
	outdatedSuffix: '(outdated)',
	unknownTitle: '(title unavailable)',
	reviewPointer:
		'See the review summary comment for the full status of this pull request.',

	errorDetails: 'Error details',
	oversizedWarning: files =>
		`> ⚠️ ${files.length} file(s) were skipped because the diff exceeded the size limit and were **not reviewed**: ${files
			.map(f => `\`${f}\``)
			.join(', ')}`,
	droppedWarning: files =>
		`> ⚠️ ${files.length} finding(s) targeted file(s) outside the diff and were **discarded**: ${files
			.map(f => `\`${f}\``)
			.join(', ')}`,
};

const JA: Messages = {
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
		`今回: \`${latest.model}\` · effort \`${latest.effort}\` · ${latest.seconds}s · $${latest.costUsd.toFixed(2)}${attemptSuffixJa(latest)}`,
	failureBanner: sha =>
		`> ⚠️ 自動レビューを完了できませんでした。\`${sha}\` は未レビューです。ワークフローを再実行するか、ジョブのログを確認してください。`,
	outdatedSuffix: '(outdated)',
	unknownTitle: '(タイトル不明)',
	reviewPointer:
		'この PR の全体状況はレビューサマリーコメントを参照してください。',

	errorDetails: 'エラー概要',
	oversizedWarning: files =>
		`> ⚠️ 差分がサイズ上限を超えたため ${files.length} 件のファイルを**レビューしていません**: ${files
			.map(f => `\`${f}\``)
			.join(', ')}`,
	droppedWarning: files =>
		`> ⚠️ 差分に含まれないファイルへの指摘 ${files.length} 件を**破棄しました**: ${files
			.map(f => `\`${f}\``)
			.join(', ')}`,
};

export function messages(lang: Language): Messages {
	return lang === 'ja' ? JA : EN;
}
