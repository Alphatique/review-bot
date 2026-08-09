import { describe, expect, test } from 'bun:test';
import type { Board, ThreadInfo } from '../../src/core/board';
import type { KeyedFinding } from '../../src/core/dedupe';
import { parseInlineMarker, type RunRecord } from '../../src/core/marker';
import {
	renderInlineComment,
	renderSticky,
	type StickyInput,
} from '../../src/core/render';

function thread(overrides: Partial<ThreadInfo> = {}): ThreadInfo {
	return {
		key: 'a'.repeat(12),
		severity: 'critical',
		title: 'トークンがログに出る',
		file: 'src/io/github.ts',
		line: 88,
		url: 'https://example.test/1',
		isResolved: false,
		isOutdated: false,
		...overrides,
	};
}

function board(threads: readonly ThreadInfo[] = []): Board {
	const outstanding = threads.filter(t => !t.isResolved);
	const counts = { critical: 0, major: 0, minor: 0 };
	for (const t of outstanding) counts[t.severity] += 1;
	return {
		outstanding: [...outstanding],
		resolved: threads.filter(t => t.isResolved),
		counts,
	};
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		commit: 'a1b2c3d',
		mode: 'auto',
		newFindings: 1,
		event: 'COMMENT',
		costUsd: 0.18,
		seconds: 42,
		attempts: 1,
		model: 'claude-sonnet-5',
		effort: 'high',
		...overrides,
	};
}

function input(overrides: Partial<StickyInput> = {}): StickyInput {
	return {
		lang: 'ja',
		board: board(),
		runs: [],
		reviewedSha: 'a1b2c3d',
		latest: null,
		failure: null,
		oversizedFiles: [],
		...overrides,
	};
}

describe('renderSticky', () => {
	test('sticky マーカーに reviewed sha を埋める', () => {
		expect(renderSticky(input())).toContain(
			'<!-- review-bot:v1 sticky reviewed=a1b2c3d -->',
		);
	});

	test('未解決ゼロなら見出しを出さず「ありません」と書く', () => {
		const body = renderSticky(input());
		expect(body).not.toContain('### 未解決の指摘');
		expect(body).toContain('未解決の指摘はありません');
	});

	test('未解決があれば見出しとリンク行を出す', () => {
		const body = renderSticky(input({ board: board([thread()]) }));
		expect(body).toContain('### 未解決の指摘');
		expect(body).toContain(
			'- 🔴 [トークンがログに出る](https://example.test/1) — `src/io/github.ts:88`',
		);
		expect(body).toContain('未解決 **1** 件');
		expect(body).toContain('🔴 1');
	});

	test('未解決セクションは details で畳まない', () => {
		const body = renderSticky(input({ board: board([thread()]) }));
		const outstandingIndex = body.indexOf('### 未解決の指摘');
		const detailsIndex = body.indexOf('<details>');
		expect(outstandingIndex).toBeGreaterThan(-1);
		expect(detailsIndex === -1 || detailsIndex > outstandingIndex).toBe(true);
	});

	test('outdated には印を付ける', () => {
		const body = renderSticky(
			input({ board: board([thread({ isOutdated: true })]) }),
		);
		expect(body).toContain('`src/io/github.ts:88` (outdated)');
	});

	test('line が null ならファイルパスだけを出す', () => {
		const body = renderSticky(input({ board: board([thread({ line: null })]) }));
		expect(body).toContain('— `src/io/github.ts`');
		expect(body).not.toContain('github.ts:');
	});

	test('title が null ならフォールバック文言を使う', () => {
		const body = renderSticky(input({ board: board([thread({ title: null })]) }));
		expect(body).toContain('[(タイトル不明)](https://example.test/1)');
	});

	test('解決済みは details に畳み、取り消し線を付ける', () => {
		const body = renderSticky(
			input({
				board: board([thread({ isResolved: true, title: 'N+1 クエリ' })]),
			}),
		);
		expect(body).toContain('<summary>解決済み (1)</summary>');
		expect(body).toContain('~~[N+1 クエリ](https://example.test/1)~~');
	});

	test('解決済みがゼロなら details ごと出さない', () => {
		expect(renderSticky(input())).not.toContain('解決済み');
	});

	test('履歴テーブルのコスト列と summary の累計が一致する', () => {
		const body = renderSticky(
			input({
				runs: [run({ costUsd: 0.18 }), run({ commit: 'b', costUsd: 0.31 })],
			}),
		);
		expect(body).toContain('<summary>レビュー履歴 (2 回 · 合計 $0.49)</summary>');
		expect(body).toContain('| $0.18 |');
		expect(body).toContain('| $0.31 |');
	});

	test('FAILED 行は判定に失敗を出し、新規件数を — にする', () => {
		const body = renderSticky(
			input({ runs: [run({ event: 'FAILED', newFindings: 0 })] }),
		);
		expect(body).toContain('| ⚠️ 失敗 |');
		expect(body).toContain('| 増分 | — |');
	});

	test('NONE 行は判定を — にする', () => {
		const body = renderSticky(
			input({ runs: [run({ event: 'NONE', newFindings: 0 })] }),
		);
		expect(body).toContain('| — | — |');
	});

	test('mode: full は範囲を全体と出す', () => {
		const body = renderSticky(input({ runs: [run({ mode: 'full' })] }));
		expect(body).toContain('| 全体 |');
	});

	test('run マーカーを時系列どおり末尾に出す', () => {
		const body = renderSticky(
			input({ runs: [run({ commit: 'first' }), run({ commit: 'second' })] }),
		);
		expect(body.indexOf('run commit=first')).toBeLessThan(
			body.indexOf('run commit=second'),
		);
	});

	test('履歴がゼロなら履歴 details を出さない', () => {
		expect(renderSticky(input())).not.toContain('レビュー履歴');
	});

	test('latest があれば実行情報を出す', () => {
		const body = renderSticky(
			input({
				latest: {
					model: 'claude-sonnet-5',
					effort: 'high',
					seconds: 42,
					costUsd: 0.18,
					attempts: 1,
				},
			}),
		);
		expect(body).toContain('<summary>実行情報</summary>');
		expect(body).toContain('`claude-sonnet-5` · effort `high` · 42s · $0.18');
		expect(body).not.toContain('回目で成功');
	});

	test('リトライした場合は attempt 数を添える', () => {
		const body = renderSticky(
			input({
				latest: {
					model: 'claude-sonnet-5',
					effort: 'high',
					seconds: 90,
					costUsd: 0.4,
					attempts: 3,
				},
			}),
		);
		expect(body).toContain('（3 回目で成功）');
	});

	test('失敗バナーを先頭に出す', () => {
		const body = renderSticky(input({ failure: 'agent timed out' }));
		expect(body).toContain('自動レビューを完了できませんでした');
		expect(body).toContain('agent timed out');
		expect(body.indexOf('⚠️')).toBeLessThan(body.indexOf('までレビュー済み'));
	});

	test('失敗バナーの中でも board は通常どおり描く', () => {
		const body = renderSticky(
			input({ failure: 'boom', board: board([thread()]) }),
		);
		expect(body).toContain('### 未解決の指摘');
	});

	test('oversized 警告を出す', () => {
		const body = renderSticky(input({ oversizedFiles: ['src/big.ts'] }));
		expect(body).toContain('レビューしていません');
		expect(body).toContain('`src/big.ts`');
	});

	test('en でも同じ構造で描ける', () => {
		const body = renderSticky(
			input({ lang: 'en', board: board([thread()]), runs: [run()] }),
		);
		expect(body).toContain('## 🤖 Code Review');
		expect(body).toContain('### Outstanding findings');
		expect(body).toContain('Reviewed up to `a1b2c3d`');
		expect(body).toContain('<!-- review-bot:v1 sticky reviewed=a1b2c3d -->');
	});
});

describe('renderInlineComment', () => {
	const finding: KeyedFinding = {
		key: 'abc123def456',
		severity: 'critical',
		file: 'src/a.ts',
		line: 3,
		title: 'null 参照',
		body: '本文',
	};

	test('見出しと本文とマーカーを出す', () => {
		const body = renderInlineComment(finding, 'ja');
		expect(body.split('\n')[0]).toBe('🔴 **critical** — null 参照');
		expect(body).toContain('本文');
		expect(parseInlineMarker(body)).toEqual({
			key: 'abc123def456',
			severity: 'critical',
		});
	});
});
