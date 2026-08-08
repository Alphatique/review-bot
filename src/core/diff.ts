import picomatch from 'picomatch';

/** レビュー対象外にする既定の glob。ユーザー指定はこれに追加される。 */
export const DEFAULT_EXCLUDE: readonly string[] = [
	'**/bun.lock',
	'**/bun.lockb',
	'**/package-lock.json',
	'**/yarn.lock',
	'**/pnpm-lock.yaml',
	'**/Cargo.lock',
	'**/poetry.lock',
	'**/Gemfile.lock',
	'**/composer.lock',
	'**/go.sum',
	'**/*.gen.*',
	'**/*.generated.*',
	'**/dist/**',
	'**/build/**',
	'**/vendor/**',
	'**/node_modules/**',
	'**/*.min.js',
	'**/*.min.css',
	'**/*.map',
	'**/*.snap',
];

export interface DiffAnalysis {
	/** モデルに渡す diff 本文。 */
	text: string;
	/** 除外パターンで落としたファイル。 */
	excludedFiles: string[];
	/** サイズ上限で落としたファイル。空でなければレビューは不完全。 */
	oversizedFiles: string[];
	/** ファイルパス → インラインコメント可能な変更後行番号の集合。 */
	commentableLines: Map<string, Set<number>>;
}

interface FileChunk {
	path: string;
	text: string;
}

export interface AnalyzeDiffOptions {
	exclude: readonly string[];
	maxBytes: number;
}

export function analyzeDiff(
	raw: string,
	options: AnalyzeDiffOptions,
): DiffAnalysis {
	const chunks = splitByFile(raw);
	const isExcluded = picomatch(options.exclude as string[], { dot: true });

	const kept: string[] = [];
	const excludedFiles: string[] = [];
	const oversizedFiles: string[] = [];
	const commentableLines = new Map<string, Set<number>>();
	let size = 0;

	for (const chunk of chunks) {
		if (!chunk.path || isExcluded(chunk.path)) {
			if (chunk.path) excludedFiles.push(chunk.path);
			continue;
		}

		const bytes = Buffer.byteLength(chunk.text, 'utf8');
		if (size + bytes > options.maxBytes) {
			oversizedFiles.push(chunk.path);
			continue;
		}

		kept.push(chunk.text);
		size += bytes;
		commentableLines.set(chunk.path, collectCommentableLines(chunk.text));
	}

	return {
		text: kept.join(''),
		excludedFiles,
		oversizedFiles,
		commentableLines,
	};
}

export function isCommentable(
	analysis: DiffAnalysis,
	file: string,
	line: number,
): boolean {
	return analysis.commentableLines.get(file)?.has(line) ?? false;
}

function splitByFile(raw: string): FileChunk[] {
	if (!raw.trim()) return [];
	return raw
		.split(/(?=^diff --git )/m)
		.filter(part => part.length > 0)
		.map(text => ({ path: extractPath(text), text }));
}

function extractPath(chunkText: string): string {
	// `+++ b/path` を優先する。リネーム時に `diff --git` 行より正確なため。
	const plusMatch = /^\+\+\+ b\/(.+)$/m.exec(chunkText);
	if (plusMatch?.[1] && plusMatch[1] !== '/dev/null') return plusMatch[1];

	const firstLine = chunkText.split('\n', 1)[0] ?? '';
	const gitMatch = /^diff --git a\/.+? b\/(.+)$/.exec(firstLine);
	return gitMatch?.[1] ?? '';
}

/**
 * 変更後ファイルにおいて、インラインコメントを付けられる行番号を集める。
 * 追加行 (`+`) と文脈行 (` `) が対象。削除行 (`-`) は変更後に存在しない。
 */
function collectCommentableLines(chunkText: string): Set<number> {
	const lines = new Set<number>();
	let newLineNo = 0;
	let inHunk = false;

	for (const line of chunkText.split('\n')) {
		const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (hunkHeader) {
			newLineNo = Number.parseInt(hunkHeader[1]!, 10);
			inHunk = true;
			continue;
		}
		if (!inHunk) continue;

		const marker = line[0];
		if (marker === '+' || marker === ' ') {
			lines.add(newLineNo);
			newLineNo += 1;
		} else if (marker === '-') {
			// 変更後には存在しない。
		} else if (line.startsWith('\\')) {
			// "\ No newline at end of file"
		} else if (line === '') {
			// 末尾の空行。文脈行の空行はスペース 1 文字で始まるのでここには来ない。
		} else {
			inHunk = false;
		}
	}

	return lines;
}
