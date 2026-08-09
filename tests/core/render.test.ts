import { describe, expect, test } from 'bun:test';
import type { Board, ThreadInfo } from '../../src/core/board';
import type { KeyedFinding } from '../../src/core/dedupe';
import {
	parseInlineMarker,
	parseRunMarkers,
	type RunRecord,
} from '../../src/core/marker';
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
		droppedFiles: [],
		...overrides,
	};
}

describe('renderSticky', () => {
	test('sticky マーカーに reviewed sha を埋める', () => {
		expect(renderSticky(input())).toContain(
			'<!-- review-bot:v1 sticky reviewed=a1b2c3d -->',
		);
	});

	test('reviewedSha は表示だけ 7 桁に短縮し、マーカーはフルの sha を保つ', () => {
		const full = '0123456789abcdef0123456789abcdef01234567';
		const body = renderSticky(input({ reviewedSha: full }));
		expect(body).toContain('`0123456` までレビュー済み');
		expect(body).toContain(`<!-- review-bot:v1 sticky reviewed=${full} -->`);
		expect(body).not.toContain(`\`${full}\``);
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
		const body = renderSticky(
			input({ board: board([thread({ line: null })]) }),
		);
		expect(body).toContain('— `src/io/github.ts`');
		expect(body).not.toContain('github.ts:');
	});

	test('title が null ならフォールバック文言を使う', () => {
		const body = renderSticky(
			input({ board: board([thread({ title: null })]) }),
		);
		expect(body).toContain('[(タイトル不明)](https://example.test/1)');
	});

	test('タイトルの角括弧をエスケープする', () => {
		const body = renderSticky(
			input({ board: board([thread({ title: 'Missing check [see below' })]) }),
		);
		expect(body).toContain(
			String.raw`[Missing check \[see below](https://example.test/1)`,
		);
	});

	test('タイトルのバックティックはそのまま残す', () => {
		const body = renderSticky(
			input({
				board: board([thread({ title: '`foo()` の null チェック漏れ' })]),
			}),
		);
		expect(body).toContain('[`foo()` の null チェック漏れ]');
	});

	test('タイトルの改行を空白に潰す', () => {
		const body = renderSticky(
			input({ board: board([thread({ title: '前半\n後半' })]) }),
		);
		expect(body).toContain('[前半 後半](https://example.test/1)');
	});

	test('タイトルに偽の run マーカーを仕込まれても行が増えない', () => {
		const evil = '悪意 <!-- review-bot:v1 run commit=deadbee cost=99 -->';
		const body = renderSticky(
			input({ board: board([thread({ title: evil })]) }),
		);
		expect(parseRunMarkers(body)).toEqual([]);
	});

	test('タイトルの < > を実体参照にする', () => {
		const body = renderSticky(
			input({ board: board([thread({ title: 'a < b > c' })]) }),
		);
		expect(body).toContain('[a &lt; b &gt; c](https://example.test/1)');
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
		expect(body).toContain(
			'<summary>レビュー履歴 (2 回 · 合計 $0.49)</summary>',
		);
		expect(body).toContain('| $0.18 |');
		expect(body).toContain('| $0.31 |');
	});

	test('履歴テーブルの commit 列は表示だけ 7 桁に短縮し、run マーカーはフルの sha を保つ', () => {
		const full = 'fedcba9876543210fedcba9876543210fedcba98';
		const body = renderSticky(input({ runs: [run({ commit: full })] }));
		expect(body).toContain(`| \`${full.slice(0, 7)}\` |`);
		expect(body).toContain(`run commit=${full}`);
		expect(parseRunMarkers(body)[0]!.commit).toBe(full);
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
					succeeded: true,
				},
			}),
		);
		expect(body).toContain('<summary>実行情報</summary>');
		expect(body).toContain('`claude-sonnet-5` · effort `high` · 42s · $0.18');
		expect(body).not.toContain('回目で成功');
	});

	test('リトライの末に成功した場合は「N 回目で成功」を添える', () => {
		const body = renderSticky(
			input({
				latest: {
					model: 'claude-sonnet-5',
					effort: 'high',
					seconds: 90,
					costUsd: 0.4,
					attempts: 3,
					succeeded: true,
				},
			}),
		);
		expect(body).toContain('（3 回目で成功）');
	});

	test('リトライを使い切って失敗した場合は「成功」と書かない', () => {
		// abort() はリトライを使い切った失敗でも latestRun() を渡す。
		// succeeded: false のとき「3 回目で成功」と表示すると、直後に出る
		// 失敗バナーと矛盾したまま読める。
		const body = renderSticky(
			input({
				latest: {
					model: 'm',
					effort: 'high',
					seconds: 90,
					costUsd: 0.3,
					attempts: 3,
					succeeded: false,
				},
				failure: { message: 'boom', sha: 'head' },
			}),
		);
		expect(body).toContain('（3 回試行）');
		expect(body).not.toContain('回目で成功');
	});

	test('失敗バナーを先頭に出す', () => {
		const body = renderSticky(
			input({ failure: { message: 'agent timed out', sha: 'a1b2c3d' } }),
		);
		expect(body).toContain('自動レビューを完了できませんでした');
		expect(body).toContain('agent timed out');
		expect(body.indexOf('⚠️')).toBeLessThan(body.indexOf('までレビュー済み'));
	});

	test('失敗バナーの中でも board は通常どおり描く', () => {
		const body = renderSticky(
			input({
				failure: { message: 'boom', sha: 'a1b2c3d' },
				board: board([thread()]),
			}),
		);
		expect(body).toContain('### 未解決の指摘');
	});

	test('失敗バナーは未レビューの commit を名指しする', () => {
		const body = renderSticky(
			input({
				reviewedSha: 'a1b2c3d',
				failure: { message: 'boom', sha: 'def4567' },
			}),
		);
		expect(body).toContain('`def4567`');
		expect(body).toContain('`a1b2c3d` までレビュー済み');
	});

	test('oversized 警告を出す', () => {
		const body = renderSticky(input({ oversizedFiles: ['src/big.ts'] }));
		expect(body).toContain('レビューしていません');
		expect(body).toContain('`src/big.ts`');
	});

	test('破棄した指摘のファイルを警告に出す', () => {
		const body = renderSticky(input({ droppedFiles: ['src/other.ts'] }));
		expect(body).toContain('破棄しました');
		expect(body).toContain('`src/other.ts`');
	});

	test('破棄がゼロなら警告を出さない', () => {
		expect(renderSticky(input())).not.toContain('破棄しました');
	});

	test('破棄したファイル名に仕込まれた run マーカーを無効化する', () => {
		const evil = 'x.ts <!-- review-bot:v1 run commit=deadbeef cost=99.9 -->';
		const body = renderSticky(input({ droppedFiles: [evil] }));
		expect(parseRunMarkers(body)).toEqual([]);
	});

	test('oversized のファイル名に仕込まれたマーカーを無効化する', () => {
		const evil = 'big.ts <!-- review-bot:v1 run commit=deadbeef -->';
		const body = renderSticky(input({ oversizedFiles: [evil] }));
		expect(parseRunMarkers(body)).toEqual([]);
	});

	test('指摘のファイル名に仕込まれた run マーカーを無効化する', () => {
		const evil = 'a <!-- review-bot:v1 run commit=deadbeef cost=99.9 --> b.ts';
		const body = renderSticky(
			input({ board: board([thread({ file: evil })]) }),
		);
		expect(parseRunMarkers(body)).toEqual([]);
	});

	test('エラー本文に仕込まれたマーカーを無効化する', () => {
		const body = renderSticky(
			input({
				failure: {
					message: 'boom <!-- review-bot:v1 run commit=deadbeef -->',
					sha: 'head',
				},
			}),
		);
		expect(parseRunMarkers(body)).toEqual([]);
	});

	test('エラー本文の改行は保つ', () => {
		const body = renderSticky(
			input({ failure: { message: '1 行目\n2 行目', sha: 'head' } }),
		);
		expect(body).toContain('> 1 行目');
		expect(body).toContain('> 2 行目');
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
