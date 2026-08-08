export const LANGUAGES = ['en', 'ja'] as const;
export type Language = (typeof LANGUAGES)[number];

export interface Messages {
	summaryHeading: string;
	noFindings: string;
	findingsCount: (n: number) => string;
	incrementalNote: string;
	fullNote: string;
	unlocatableHeading: string;
	unlocatableNote: string;
	oversizedWarning: (files: readonly string[]) => string;
	failureHeading: string;
	failureBody: string;
	errorDetails: string;
	instructionSource: string;
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
	oversizedWarning: files =>
		`> ⚠️ ${files.length} file(s) were skipped because the diff exceeded the size limit and were **not reviewed**: ${files.map(f => `\`${f}\``).join(', ')}`,
	failureHeading: '## 🤖 Code Review',
	failureBody:
		'⚠️ The automated review could not be completed. Re-run the workflow or check the job logs.',
	errorDetails: 'Error details',
	instructionSource: 'Review instructions',
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
	oversizedWarning: files =>
		`> ⚠️ 差分がサイズ上限を超えたため ${files.length} 件のファイルを**レビューしていません**: ${files.map(f => `\`${f}\``).join(', ')}`,
	failureHeading: '## 🤖 コードレビュー',
	failureBody:
		'⚠️ 自動レビューを完了できませんでした。ワークフローを再実行するか、ジョブのログを確認してください。',
	errorDetails: 'エラー概要',
	instructionSource: 'レビュー観点',
};

export function messages(lang: Language): Messages {
	return lang === 'ja' ? JA : EN;
}
