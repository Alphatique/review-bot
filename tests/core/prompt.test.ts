import { describe, expect, test } from 'bun:test';
import { buildPrompt, DEFAULT_INSTRUCTIONS } from '../../src/core/prompt';

const BASE = {
	instructions: DEFAULT_INSTRUCTIONS,
	repo: 'owner/repo',
	prNumber: 42,
	prTitle: 'feat: add thing',
	diff: 'diff --git a/a.ts b/a.ts\n+const x = 1;\n',
	lang: 'ja' as const,
	oversizedFiles: [] as string[],
	toolName: 'mcp__review__submit_review',
};

describe('buildPrompt', () => {
	test('レビュー観点を含む', () => {
		expect(buildPrompt(BASE)).toContain(DEFAULT_INSTRUCTIONS.slice(0, 40));
	});

	test('PR のメタ情報を含む', () => {
		const out = buildPrompt(BASE);
		expect(out).toContain('owner/repo');
		expect(out).toContain('#42');
		expect(out).toContain('feat: add thing');
	});

	test('diff を含む', () => {
		expect(buildPrompt(BASE)).toContain('const x = 1;');
	});

	test('diff が信頼できないデータであると宣言する', () => {
		const out = buildPrompt(BASE);
		expect(out).toMatch(/信頼できない|untrusted/i);
	});

	test('ツール名を明示する', () => {
		expect(buildPrompt(BASE)).toContain('mcp__review__submit_review');
	});

	test('出力言語を指示する', () => {
		expect(buildPrompt({ ...BASE, lang: 'ja' })).toMatch(/日本語|Japanese/);
		expect(buildPrompt({ ...BASE, lang: 'en' })).toMatch(/English/);
	});

	test('除外ファイルがあれば注意書きを入れる', () => {
		const out = buildPrompt({ ...BASE, oversizedFiles: ['src/huge.ts'] });
		expect(out).toContain('src/huge.ts');
	});

	test('カスタム観点を差し込める', () => {
		const out = buildPrompt({ ...BASE, instructions: 'タブを使うこと' });
		expect(out).toContain('タブを使うこと');
	});
});
