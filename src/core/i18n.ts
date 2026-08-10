export const LANGUAGES = ['en', 'ja'] as const;
export type Language = (typeof LANGUAGES)[number];

export interface Messages {
	reviewHeading: string;
	noFindings: string;
	findingsCount: (n: number) => string;
	resolvedCount: (n: number) => string;
	droppedNote: (files: readonly string[]) => string;
	commentFailedNote: (files: readonly string[]) => string;
	excludedNote: (files: readonly string[]) => string;
	oversizedWarning: (files: readonly string[]) => string;
	failureBody: string;
	errorDetails: string;
	resolveReply: (sha: string, reason: string) => string;
}

const list = (files: readonly string[]): string =>
	files.map(file => `\`${file}\``).join(', ');

const EN: Messages = {
	reviewHeading: '## 🤖 Code Review',
	noFindings: 'No new findings.',
	findingsCount: n => `${n} new finding${n === 1 ? '' : 's'} posted.`,
	resolvedCount: n =>
		`${n} finding${n === 1 ? '' : 's'} resolved automatically.`,
	droppedNote: files =>
		`> ⚠️ Findings pointing outside this diff were discarded and **not** reported: ${list(files)}`,
	commentFailedNote: files =>
		`> ⚠️ Some findings could not be posted as comments and are **not tracked**: ${list(files)}`,
	excludedNote: files => `Excluded from review: ${list(files)}`,
	oversizedWarning: files =>
		`> ⚠️ ${files.length} file(s) were skipped because the diff exceeded the size limit and were **not reviewed**: ${list(files)}`,
	failureBody:
		'⚠️ The automated review could not be completed. Re-run the workflow or check the job logs.',
	errorDetails: 'Error details',
	resolveReply: (sha, reason) =>
		`✅ Resolved automatically: this looks fixed as of \`${sha}\`.\n\n${reason}`,
};

const JA: Messages = {
	reviewHeading: '## 🤖 コードレビュー',
	noFindings: '新規の指摘はありません。',
	findingsCount: n => `${n} 件の新規指摘を投稿しました。`,
	resolvedCount: n => `${n} 件の指摘を自動で解決済みにしました。`,
	droppedNote: files =>
		`> ⚠️ 差分に含まれないファイルへの指摘を破棄しました（**報告していません**）: ${list(files)}`,
	commentFailedNote: files =>
		`> ⚠️ コメントとして投稿できなかった指摘があります（**追跡されません**）: ${list(files)}`,
	excludedNote: files => `レビュー対象から除外: ${list(files)}`,
	oversizedWarning: files =>
		`> ⚠️ 差分がサイズ上限を超えたため ${files.length} 件のファイルを**レビューしていません**: ${list(files)}`,
	failureBody:
		'⚠️ 自動レビューを完了できませんでした。ワークフローを再実行するか、ジョブのログを確認してください。',
	errorDetails: 'エラー概要',
	resolveReply: (sha, reason) =>
		`✅ 自動で解決済みにしました。\`${sha}\` の時点で解消していると判断しました。\n\n${reason}`,
};

export function messages(lang: Language): Messages {
	return lang === 'ja' ? JA : EN;
}
