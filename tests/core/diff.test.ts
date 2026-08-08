import { describe, expect, test } from 'bun:test';
import {
	analyzeDiff,
	DEFAULT_EXCLUDE,
	isCommentable,
} from '../../src/core/diff';

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 const x = 1;
-const y = 2;
+const y = 3;
+const z = 4;
 const w = 5;
diff --git a/bun.lock b/bun.lock
index 3333333..4444444 100644
--- a/bun.lock
+++ b/bun.lock
@@ -1,2 +1,2 @@
-old
+new
`;

describe('analyzeDiff', () => {
	test('ファイル単位に分割して除外パターンを適用する', () => {
		const result = analyzeDiff(SAMPLE, {
			exclude: DEFAULT_EXCLUDE,
			maxBytes: 1_000_000,
		});
		expect(result.excludedFiles).toContain('bun.lock');
		expect(result.text).toContain('src/a.ts');
		expect(result.text).not.toContain('bun.lock');
	});

	test('コメント可能行を変更後ファイルの行番号で算出する', () => {
		const result = analyzeDiff(SAMPLE, { exclude: [], maxBytes: 1_000_000 });
		const lines = result.commentableLines.get('src/a.ts');
		expect(lines).toBeDefined();
		// @@ -1,4 +1,5 @@ なので変更後は 1 行目から。
		// 1: ' const x = 1;'  → 文脈行
		// -: '-const y = 2;'  → 変更後に存在しない
		// 2: '+const y = 3;'  → 追加行
		// 3: '+const z = 4;'  → 追加行
		// 4: ' const w = 5;'  → 文脈行
		expect([...lines!].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
	});

	test('除外したファイルはコメント可能行にも現れない', () => {
		const result = analyzeDiff(SAMPLE, {
			exclude: DEFAULT_EXCLUDE,
			maxBytes: 1_000_000,
		});
		expect(result.commentableLines.has('bun.lock')).toBe(false);
	});

	test('サイズ上限を超えたファイルは oversizedFiles に入り本文から落ちる', () => {
		const result = analyzeDiff(SAMPLE, { exclude: [], maxBytes: 10 });
		expect(result.oversizedFiles.length).toBeGreaterThan(0);
		expect(result.text.length).toBeLessThan(SAMPLE.length);
	});

	test('空の diff を安全に扱う', () => {
		const result = analyzeDiff('', { exclude: [], maxBytes: 1000 });
		expect(result.text).toBe('');
		expect(result.commentableLines.size).toBe(0);
	});

	test('ユーザー指定の除外パターンが既定に追加される', () => {
		const result = analyzeDiff(SAMPLE, {
			exclude: [...DEFAULT_EXCLUDE, 'src/**'],
			maxBytes: 1_000_000,
		});
		expect(result.excludedFiles).toContain('src/a.ts');
		expect(result.text).toBe('');
	});
});

describe('isCommentable', () => {
	test('存在する行なら true', () => {
		const result = analyzeDiff(SAMPLE, { exclude: [], maxBytes: 1_000_000 });
		expect(isCommentable(result, 'src/a.ts', 2)).toBe(true);
	});

	test('diff に無い行なら false', () => {
		const result = analyzeDiff(SAMPLE, { exclude: [], maxBytes: 1_000_000 });
		expect(isCommentable(result, 'src/a.ts', 999)).toBe(false);
	});

	test('未知のファイルなら false', () => {
		const result = analyzeDiff(SAMPLE, { exclude: [], maxBytes: 1_000_000 });
		expect(isCommentable(result, 'nope.ts', 1)).toBe(false);
	});
});
