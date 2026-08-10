import { describe, expect, test } from 'bun:test';
import { buildPrompt, DEFAULT_INSTRUCTIONS } from '../../src/core/prompt';
import type { ThreadInfo } from '../../src/core/thread';

function thread(overrides: Partial<ThreadInfo> = {}): ThreadInfo {
	return {
		id: 'PRRT_1',
		commentId: 1,
		key: 'a'.repeat(12),
		severity: 'major',
		file: 'src/a.ts',
		line: 12,
		title: 'null 参照の可能性',
		isResolved: false,
		isOutdated: false,
		...overrides,
	};
}

function base() {
	return {
		instructions: 'レビューして',
		repo: 'owner/repo',
		prNumber: 1,
		prTitle: 'feat: x',
		diff: 'diff --git a/a.ts b/a.ts',
		lang: 'ja' as const,
		oversizedFiles: [],
		toolName: 'submit_review',
		outstanding: [],
		resolvedThreads: [],
		autoResolve: true,
	};
}

const BASE = {
	instructions: DEFAULT_INSTRUCTIONS,
	repo: 'owner/repo',
	prNumber: 42,
	prTitle: 'feat: add thing',
	diff: 'diff --git a/a.ts b/a.ts\n+const x = 1;\n',
	lang: 'ja' as const,
	oversizedFiles: [] as string[],
	toolName: 'mcp__review__submit_review',
	outstanding: [] as ThreadInfo[],
	resolvedThreads: [] as ThreadInfo[],
	autoResolve: true,
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

describe('未解決一覧', () => {
	test('key / severity / タイトル / 位置を載せる', () => {
		const out = buildPrompt({ ...base(), outstanding: [thread()] });
		expect(out).toContain('a'.repeat(12));
		expect(out).toContain('major');
		expect(out).toContain('null 参照の可能性');
		expect(out).toContain('src/a.ts:12');
	});

	test('untrusted 宣言を付ける', () => {
		const out = buildPrompt({ ...base(), outstanding: [thread()] });
		expect(out).toContain('untrusted');
	});

	test('タイトルが読めなければ位置だけ出す', () => {
		const out = buildPrompt({
			...base(),
			outstanding: [thread({ title: null })],
		});
		expect(out).toContain('src/a.ts:12');
	});

	test('line が null なら位置をファイル名だけにする', () => {
		const out = buildPrompt({
			...base(),
			outstanding: [thread({ line: null })],
		});
		expect(out).toContain('src/a.ts');
	});

	test('auto-resolve が false なら載せない', () => {
		const out = buildPrompt({
			...base(),
			outstanding: [thread()],
			autoResolve: false,
		});
		expect(out).not.toContain('a'.repeat(12));
	});

	test('未解決が無ければ節ごと出さない', () => {
		const out = buildPrompt(base());
		expect(out).not.toContain('## 未解決の指摘');
	});
});

describe('解決済み一覧', () => {
	test('タイトルとファイルを載せる', () => {
		const out = buildPrompt({
			...base(),
			resolvedThreads: [thread({ title: '古い指摘', isResolved: true })],
		});
		expect(out).toContain('古い指摘');
	});

	test('auto-resolve が false でも載せる', () => {
		const out = buildPrompt({
			...base(),
			resolvedThreads: [thread({ title: '古い指摘', isResolved: true })],
			autoResolve: false,
		});
		expect(out).toContain('古い指摘');
	});

	test('解決済みが無ければ節ごと出さない', () => {
		const out = buildPrompt(base());
		expect(out).not.toContain('## 解決済みの指摘');
	});
});
