# sticky サマリーコメント Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PR ごとに 1 つの sticky コメントを状態ボードとして更新し続け、未解決指摘の索引・レビュー履歴・累計コストをそこに集約する。

**Architecture:** 状態の持ち主を Review から sticky issue comment へ移す。sticky に `reviewed=<sha>`（増分の起点）と `run` マーカー群（履歴・コスト）を埋め、指摘そのものは review スレッドから毎回復元する。Review はインラインコメントと APPROVE / REQUEST_CHANGES の運搬手段に徹し、必要なときだけ作る。

**Tech Stack:** TypeScript / Bun（テスト） / `@actions/github`（Octokit REST + GraphQL） / zod / tsdown

## Global Constraints

- 設計の出典は `docs/superpowers/specs/2026-08-09-sticky-summary-design.md`。迷ったら spec を正とする。
- インデントは**タブ文字**。既存ファイルに合わせる。フォーマットは `bun run fmt`（oxfmt）。
- コメントは日本語。既存コードのコメント密度に合わせ、「なぜそうしたか」を書く。「何をしているか」は書かない。
- テストは `bun:test`。テスト名は日本語。既存の `tests/core/*.test.ts` の書き方に倣う。
- 各タスクの最後に `bun run typecheck && bun run lint && bun test` が全て通ること。
- マーカー文字列 `review-bot:v1` のプレフィックスは変更しない。
- 作業ブランチは `feat/sticky-summary`。コミットは日本語 1 行サマリ + 必要なら本文。

---

## File Structure

| ファイル                                       | 責務                                                    | タスク |
| ---------------------------------------------- | ------------------------------------------------------- | ------ |
| `src/core/marker.ts`                           | マーカーの build / parse とタイトル抽出。純関数のみ     | 1      |
| `src/core/board.ts`                            | **新規**。スレッド一覧を表示順の未解決 / 解決済みに整理 | 2      |
| `src/core/decision.ts`                         | 提出イベントの決定                                      | 3      |
| `src/core/i18n.ts`                             | 表示文言                                                | 4      |
| `src/core/render.ts`                           | sticky 本文とインラインコメント本文の組み立て           | 4      |
| `src/io/agent.ts`                              | Agent 実行とメトリクス抽出                              | 5      |
| `src/io/github.ts`                             | GitHub API との境界                                     | 6      |
| `src/config.ts` / `action.yml` / `src/main.ts` | 入出力の配線                                            | 7      |
| `src/orchestrate.ts`                           | フローの組み立て                                        | 8, 9   |
| `src/core/prompt.ts`                           | モデルへの指示                                          | 10     |
| `README.md`                                    | ドキュメント                                            | 11     |

---

## Task 1: マーカーの拡張（sticky / run / タイトル抽出）

**Files:**

- Modify: `src/core/marker.ts`
- Test: `tests/core/marker.test.ts`

**Interfaces:**

- Consumes: `Severity`, `SEVERITIES`（`src/core/schema.ts`、既存）
- Produces:
  - `type RunEvent = 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE' | 'NONE' | 'FAILED'`
  - `interface RunRecord { commit: string; mode: 'auto' | 'full'; newFindings: number; event: RunEvent; costUsd: number; seconds: number; attempts: number; model: string; effort: string }`
  - `buildStickyMarker(reviewed: string): string`
  - `parseStickyMarker(body: string): { reviewed: string } | null`
  - `hasStickyMarker(body: string): boolean`
  - `buildRunMarker(run: RunRecord): string`
  - `parseRunMarkers(body: string): RunRecord[]`
  - `totalCostUsd(runs: readonly RunRecord[]): number`
  - `parseInlineTitle(body: string): string | null`

`SUMMARY_MARKER` / `FAILURE_MARKER` / `hasSummaryMarker` / `hasFailureMarker` は **Task 8 まで残す**。まだ `render.ts` と `github.ts` が参照しているため、ここで消すと型が壊れる。

- [ ] **Step 1: 失敗するテストを書く**

`tests/core/marker.test.ts` の末尾に追記する。

```ts
describe('sticky marker', () => {
	test('埋め込んだ sha を取り出せる', () => {
		const body = `サマリ\n${buildStickyMarker('a1b2c3d')}`;
		expect(parseStickyMarker(body)).toEqual({ reviewed: 'a1b2c3d' });
	});

	test('マーカーが無ければ null', () => {
		expect(parseStickyMarker('ただのコメント')).toBeNull();
	});

	test('hasStickyMarker が一致する', () => {
		expect(hasStickyMarker(buildStickyMarker('abc'))).toBe(true);
		expect(hasStickyMarker('ただのコメント')).toBe(false);
	});
});

describe('run marker', () => {
	const RUN: RunRecord = {
		commit: 'a1b2c3d',
		mode: 'auto',
		newFindings: 1,
		event: 'COMMENT',
		costUsd: 0.1817,
		seconds: 42,
		attempts: 1,
		model: 'claude-sonnet-5',
		effort: 'high',
	};

	test('build したものを parse で戻せる', () => {
		expect(parseRunMarkers(buildRunMarker(RUN))).toEqual([RUN]);
	});

	test('複数行を順序どおりに読む', () => {
		const body = [
			buildRunMarker({ ...RUN, commit: 'first' }),
			buildRunMarker({ ...RUN, commit: 'second' }),
		].join('\n');
		expect(parseRunMarkers(body).map(r => r.commit)).toEqual([
			'first',
			'second',
		]);
	});

	test('未知のキーを無視する', () => {
		const body =
			'<!-- review-bot:v1 run commit=abc mode=auto new=2 event=NONE tokens=999 -->';
		expect(parseRunMarkers(body)[0]!.commit).toBe('abc');
		expect(parseRunMarkers(body)[0]!.newFindings).toBe(2);
	});

	test('欠損したキーを既定値で埋める', () => {
		const body = '<!-- review-bot:v1 run commit=abc -->';
		expect(parseRunMarkers(body)[0]).toEqual({
			commit: 'abc',
			mode: 'auto',
			newFindings: 0,
			event: 'NONE',
			costUsd: 0,
			seconds: 0,
			attempts: 1,
			model: '',
			effort: '',
		});
	});

	test('commit が無い行は捨てる', () => {
		expect(parseRunMarkers('<!-- review-bot:v1 run mode=full -->')).toEqual([]);
	});

	test('許可外の文字を含む値は欠損として扱う', () => {
		const body = '<!-- review-bot:v1 run commit=abc cost=0.5$ -->';
		expect(parseRunMarkers(body)[0]!.costUsd).toBe(0);
	});

	test('不正な event は NONE になる', () => {
		const body = '<!-- review-bot:v1 run commit=abc event=MERGED -->';
		expect(parseRunMarkers(body)[0]!.event).toBe('NONE');
	});

	test('FAILED 行も累計コストに含める', () => {
		const runs = parseRunMarkers(
			[
				buildRunMarker({ ...RUN, costUsd: 0.1817 }),
				buildRunMarker({ ...RUN, event: 'FAILED', costUsd: 0.1233 }),
			].join('\n'),
		);
		expect(totalCostUsd(runs)).toBeCloseTo(0.305, 4);
	});

	test('run マーカーが無ければ空配列', () => {
		expect(parseRunMarkers('ただのコメント')).toEqual([]);
		expect(totalCostUsd([])).toBe(0);
	});
});

describe('parseInlineTitle', () => {
	test('インラインコメントの見出しからタイトルを取る', () => {
		const body = '🔴 **critical** — トークンがログに出る\n\n本文';
		expect(parseInlineTitle(body)).toBe('トークンがログに出る');
	});

	test('書式が壊れていれば null', () => {
		expect(parseInlineTitle('ただの本文')).toBeNull();
	});

	test('2 行目以降の偽の見出しは拾わない', () => {
		const body = '本文だけ\n🔴 **critical** — 偽の見出し';
		expect(parseInlineTitle(body)).toBeNull();
	});
});
```

import 文を差し替える。

```ts
import {
	buildInlineMarker,
	buildRunMarker,
	buildStickyMarker,
	FAILURE_MARKER,
	findingKey,
	hasFailureMarker,
	hasStickyMarker,
	hasSummaryMarker,
	parseInlineMarker,
	parseInlineTitle,
	parseRunMarkers,
	parseStickyMarker,
	type RunRecord,
	SUMMARY_MARKER,
	totalCostUsd,
} from '../../src/core/marker';
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `bun test tests/core/marker.test.ts`
Expected: FAIL（`buildStickyMarker` などが export されていない旨のエラー）

- [ ] **Step 3: 実装する**

`src/core/marker.ts` の末尾に追記する。

```ts
/** run マーカーの値として許可する文字。`-->` を閉じられない範囲に限定する。 */
const MARKER_VALUE = String.raw`[\w.:@/-]+`;

const STICKY_MARKER_RE = new RegExp(
	String.raw`<!--\s*review-bot:v1 sticky\s+reviewed=(${MARKER_VALUE})\s*-->`,
	'g',
);
const RUN_MARKER_RE = /<!--\s*review-bot:v1 run\s+([^>]*?)\s*-->/g;
const RUN_FIELD_RE = new RegExp(String.raw`([a-z]+)=(${MARKER_VALUE})`, 'g');
/** `renderInlineComment` が出す 1 行目。ここからタイトルを復元する。 */
const INLINE_TITLE_RE = /\*\*(?:critical|major|minor)\*\*\s+—\s+(.+)$/;

export const RUN_EVENTS = [
	'COMMENT',
	'REQUEST_CHANGES',
	'APPROVE',
	'NONE',
	'FAILED',
] as const;
export type RunEvent = (typeof RUN_EVENTS)[number];

/** 1 回の Action 実行の記録。sticky に 1 行ずつ追記する。 */
export interface RunRecord {
	commit: string;
	mode: 'auto' | 'full';
	newFindings: number;
	event: RunEvent;
	/** 全 attempt の合計。 */
	costUsd: number;
	/** 全 attempt の合計秒数。 */
	seconds: number;
	attempts: number;
	model: string;
	effort: string;
}

export function buildStickyMarker(reviewed: string): string {
	return `<!-- review-bot:v1 sticky reviewed=${reviewed} -->`;
}

/**
 * sticky 本文には指摘タイトルがそのまま載る。タイトルは差分由来の任意文字列で
 * 攻撃者が影響を与えられるため、そこに偽マーカーを仕込まれても本文末尾の
 * 正規ブロックが勝つよう、最後の一致を採用する（parseInlineMarker と同じ方針）。
 */
export function parseStickyMarker(body: string): { reviewed: string } | null {
	const matches = [...body.matchAll(STICKY_MARKER_RE)];
	const last = matches[matches.length - 1];
	return last?.[1] ? { reviewed: last[1] } : null;
}

export function hasStickyMarker(body: string): boolean {
	return parseStickyMarker(body) !== null;
}

export function buildRunMarker(run: RunRecord): string {
	const fields = [
		`commit=${run.commit}`,
		`mode=${run.mode}`,
		`new=${run.newFindings}`,
		`event=${run.event}`,
		`cost=${run.costUsd.toFixed(4)}`,
		`sec=${Math.round(run.seconds)}`,
		`attempts=${run.attempts}`,
		`model=${run.model}`,
		`effort=${run.effort}`,
	];
	return `<!-- review-bot:v1 run ${fields.join(' ')} -->`;
}

/**
 * key=value の緩いパース。未知のキーは無視し、欠損キーは既定値で埋める。
 * こうしておけば後からキーを足しても、拡張前に書かれたマーカーがそのまま読める。
 */
export function parseRunMarkers(body: string): RunRecord[] {
	const records: RunRecord[] = [];

	for (const marker of body.matchAll(RUN_MARKER_RE)) {
		const fields = new Map<string, string>();
		for (const field of (marker[1] ?? '').matchAll(RUN_FIELD_RE)) {
			fields.set(field[1]!, field[2]!);
		}

		// commit が読めない行は履歴として意味を成さないので捨てる。
		const commit = fields.get('commit');
		if (!commit) continue;

		const event = fields.get('event');
		records.push({
			commit,
			mode: fields.get('mode') === 'full' ? 'full' : 'auto',
			newFindings: toInt(fields.get('new'), 0),
			event: (RUN_EVENTS as readonly string[]).includes(event ?? '')
				? (event as RunEvent)
				: 'NONE',
			costUsd: toNumber(fields.get('cost'), 0),
			seconds: toInt(fields.get('sec'), 0),
			attempts: toInt(fields.get('attempts'), 1),
			model: fields.get('model') ?? '',
			effort: fields.get('effort') ?? '',
		});
	}

	return records;
}

export function totalCostUsd(runs: readonly RunRecord[]): number {
	return runs.reduce((sum, run) => sum + run.costUsd, 0);
}

/**
 * インラインコメント本文の 1 行目からタイトルを復元する。
 * 書式は renderInlineComment が生成しているので安定する。読めなければ null。
 */
export function parseInlineTitle(body: string): string | null {
	const firstLine = body.split('\n', 1)[0] ?? '';
	const match = INLINE_TITLE_RE.exec(firstLine);
	return match?.[1]?.trim() || null;
}

function toNumber(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function toInt(value: string | undefined, fallback: number): number {
	const parsed = toNumber(value, fallback);
	return Number.isInteger(parsed) ? parsed : fallback;
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `bun test tests/core/marker.test.ts`
Expected: PASS（既存の findingKey / inline marker / summary marker / failure marker のテストも通ったまま）

- [ ] **Step 5: 型・lint・全テスト**

Run: `bun run typecheck && bun run lint && bun test`
Expected: 全て PASS

- [ ] **Step 6: コミット**

```bash
git add src/core/marker.ts tests/core/marker.test.ts
git commit -m "feat(marker): sticky / run マーカーとタイトル抽出を追加"
```

---

## Task 2: `board.ts`（指摘の現在状態の組み立て）

**Files:**

- Create: `src/core/board.ts`
- Test: `tests/core/board.test.ts`（新規）

**Interfaces:**

- Consumes: `Severity`, `SEVERITY_ORDER`（`src/core/schema.ts`、既存）
- Produces:
  - `interface ThreadInfo { key: string; severity: Severity; title: string | null; file: string; line: number | null; url: string; isResolved: boolean; isOutdated: boolean }`
  - `interface Board { outstanding: ThreadInfo[]; resolved: ThreadInfo[]; counts: Record<Severity, number> }`
  - `buildBoard(threads: readonly ThreadInfo[]): Board`

- [ ] **Step 1: 失敗するテストを書く**

`tests/core/board.test.ts` を新規作成する。

```ts
import { describe, expect, test } from 'bun:test';
import { type Board, buildBoard, type ThreadInfo } from '../../src/core/board';

function thread(overrides: Partial<ThreadInfo> = {}): ThreadInfo {
	return {
		key: 'a'.repeat(12),
		severity: 'major',
		title: 'タイトル',
		file: 'src/a.ts',
		line: 10,
		url: 'https://example.test/1',
		isResolved: false,
		isOutdated: false,
		...overrides,
	};
}

describe('buildBoard', () => {
	test('未解決と解決済みに振り分ける', () => {
		const board = buildBoard([
			thread({ key: 'a', isResolved: false }),
			thread({ key: 'b', isResolved: true }),
		]);
		expect(board.outstanding.map(t => t.key)).toEqual(['a']);
		expect(board.resolved.map(t => t.key)).toEqual(['b']);
	});

	test('severity 昇順に並べる', () => {
		const board = buildBoard([
			thread({ key: 'minor', severity: 'minor' }),
			thread({ key: 'critical', severity: 'critical' }),
			thread({ key: 'major', severity: 'major' }),
		]);
		expect(board.outstanding.map(t => t.key)).toEqual([
			'critical',
			'major',
			'minor',
		]);
	});

	test('同じ severity なら file, line の順に並べる', () => {
		const board = buildBoard([
			thread({ key: '3', file: 'src/b.ts', line: 1 }),
			thread({ key: '2', file: 'src/a.ts', line: 20 }),
			thread({ key: '1', file: 'src/a.ts', line: 5 }),
		]);
		expect(board.outstanding.map(t => t.key)).toEqual(['1', '2', '3']);
	});

	test('line が null でも落ちずに並ぶ', () => {
		const board = buildBoard([
			thread({ key: 'withLine', file: 'src/a.ts', line: 5 }),
			thread({ key: 'noLine', file: 'src/a.ts', line: null }),
		]);
		expect(board.outstanding.map(t => t.key)).toEqual(['noLine', 'withLine']);
	});

	test('outdated かつ未解決は未解決に入る', () => {
		const board = buildBoard([
			thread({ key: 'a', isOutdated: true, isResolved: false }),
		]);
		expect(board.outstanding).toHaveLength(1);
		expect(board.resolved).toHaveLength(0);
	});

	test('title が null でもそのまま保持する', () => {
		const board = buildBoard([thread({ title: null })]);
		expect(board.outstanding[0]!.title).toBeNull();
	});

	test('counts は未解決だけを数える', () => {
		const board = buildBoard([
			thread({ key: '1', severity: 'critical' }),
			thread({ key: '2', severity: 'major' }),
			thread({ key: '3', severity: 'major', isResolved: true }),
		]);
		expect(board.counts).toEqual({ critical: 1, major: 1, minor: 0 });
	});

	test('空入力なら空の board', () => {
		const board: Board = buildBoard([]);
		expect(board.outstanding).toEqual([]);
		expect(board.resolved).toEqual([]);
		expect(board.counts).toEqual({ critical: 0, major: 0, minor: 0 });
	});

	test('入力配列を破壊しない', () => {
		const input = [
			thread({ key: 'minor', severity: 'minor' }),
			thread({ key: 'critical', severity: 'critical' }),
		];
		buildBoard(input);
		expect(input.map(t => t.key)).toEqual(['minor', 'critical']);
	});
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `bun test tests/core/board.test.ts`
Expected: FAIL（`src/core/board` を解決できない）

- [ ] **Step 3: 実装する**

`src/core/board.ts` を新規作成する。

```ts
import { SEVERITY_ORDER, type Severity } from './schema';

/** GitHub 上に存在する bot の指摘スレッド 1 件。 */
export interface ThreadInfo {
	key: string;
	severity: Severity;
	/** インラインコメント本文から復元したタイトル。読めなければ null。 */
	title: string | null;
	file: string;
	line: number | null;
	url: string;
	isResolved: boolean;
	isOutdated: boolean;
}

/** PR 全体の指摘の現在状態を、表示順に整理したもの。 */
export interface Board {
	outstanding: ThreadInfo[];
	resolved: ThreadInfo[];
	/** outstanding のみを数える。 */
	counts: Record<Severity, number>;
}

export function buildBoard(threads: readonly ThreadInfo[]): Board {
	const outstanding = sortForDisplay(threads.filter(t => !t.isResolved));
	const resolved = sortForDisplay(threads.filter(t => t.isResolved));

	const counts: Record<Severity, number> = { critical: 0, major: 0, minor: 0 };
	for (const thread of outstanding) counts[thread.severity] += 1;

	return { outstanding, resolved, counts };
}

function sortForDisplay(threads: readonly ThreadInfo[]): ThreadInfo[] {
	return [...threads].toSorted((a, b) => {
		const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
		if (bySeverity !== 0) return bySeverity;
		// localeCompare はランタイムの既定ロケールに依存し、CI と手元で
		// 並び順が割れうる。安定した並びが欲しいので序数比較にする。
		const byFile = a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
		if (byFile !== 0) return byFile;
		return (a.line ?? 0) - (b.line ?? 0);
	});
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `bun test tests/core/board.test.ts`
Expected: PASS

- [ ] **Step 5: 型・lint・全テスト**

Run: `bun run typecheck && bun run lint && bun test`
Expected: 全て PASS

- [ ] **Step 6: コミット**

```bash
git add src/core/board.ts tests/core/board.test.ts
git commit -m "feat(board): PR 全体の指摘状態を組み立てる純関数を追加"
```

---

## Task 3: `decision.ts` の APPROVE / NONE 対応

**Files:**

- Modify: `src/core/decision.ts`
- Test: `tests/core/decision.test.ts`

**Interfaces:**

- Consumes: `Severity`, `isAtLeastAsSevere`（`src/core/schema.ts`、既存）
- Produces:
  - `type ReviewEvent = 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE'`
  - `type EventDecision = ReviewEvent | 'NONE'`
  - `decideEvent(input: DecisionInput): EventDecision`
  - `interface DecisionInput { newFindings: readonly { severity: Severity }[]; existing: readonly { severity: Severity; isResolved: boolean }[]; threshold: RequestChangesOn; canSubmitVerdict: boolean; approve: boolean }`

**設計からの変更点（1 件）:** spec の `canRequestChanges` を `canSubmitVerdict` に改名し、**APPROVE にも同じゲートをかける**。bot 自身が作成した PR には approve も 422 になるため、REQUEST_CHANGES だけを塞いでいたのでは足りない。

`ExistingFinding` 型への依存をやめ、`{ severity, isResolved }` の構造的部分型で受ける。これで `ThreadInfo` をそのまま渡せる。

- [ ] **Step 1: 失敗するテストを書く**

`tests/core/decision.test.ts` を丸ごと次の内容にする。

```ts
import { describe, expect, test } from 'bun:test';
import { decideEvent, type DecisionInput } from '../../src/core/decision';
import type { Severity } from '../../src/core/schema';

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
	return {
		newFindings: [],
		existing: [],
		threshold: 'critical',
		canSubmitVerdict: true,
		approve: false,
		...overrides,
	};
}

function severity(value: Severity): { severity: Severity } {
	return { severity: value };
}

function existing(
	value: Severity,
	isResolved: boolean,
): { severity: Severity; isResolved: boolean } {
	return { severity: value, isResolved };
}

describe('decideEvent', () => {
	test('新規も未解決も無ければ NONE', () => {
		expect(decideEvent(input())).toBe('NONE');
	});

	test('閾値未満の新規指摘だけなら COMMENT', () => {
		expect(decideEvent(input({ newFindings: [severity('minor')] }))).toBe(
			'COMMENT',
		);
	});

	test('閾値以上の新規指摘があれば REQUEST_CHANGES', () => {
		expect(decideEvent(input({ newFindings: [severity('critical')] }))).toBe(
			'REQUEST_CHANGES',
		);
	});

	test('未解決の既存指摘が閾値以上なら新規ゼロでも REQUEST_CHANGES', () => {
		expect(
			decideEvent(input({ existing: [existing('critical', false)] })),
		).toBe('REQUEST_CHANGES');
	});

	test('解決済みの既存指摘は REQUEST_CHANGES の理由にならない', () => {
		expect(decideEvent(input({ existing: [existing('critical', true)] }))).toBe(
			'NONE',
		);
	});

	test('threshold が none なら REQUEST_CHANGES にしない', () => {
		expect(
			decideEvent(
				input({ threshold: 'none', newFindings: [severity('critical')] }),
			),
		).toBe('COMMENT');
	});

	test('bot 自身の PR には REQUEST_CHANGES を出さない', () => {
		expect(
			decideEvent(
				input({
					canSubmitVerdict: false,
					newFindings: [severity('critical')],
				}),
			),
		).toBe('COMMENT');
	});

	test('approve が off なら未解決ゼロでも APPROVE しない', () => {
		expect(decideEvent(input({ approve: false }))).toBe('NONE');
	});

	test('approve が on かつ未解決ゼロなら APPROVE', () => {
		expect(
			decideEvent(
				input({ approve: true, existing: [existing('major', true)] }),
			),
		).toBe('APPROVE');
	});

	test('approve が on でも未解決があれば APPROVE せず Review も作らない', () => {
		expect(
			decideEvent(
				input({ approve: true, existing: [existing('minor', false)] }),
			),
		).toBe('NONE');
	});

	test('未解決が残っていても新規指摘が無ければ Review を作らない', () => {
		expect(decideEvent(input({ existing: [existing('minor', false)] }))).toBe(
			'NONE',
		);
	});

	test('approve が on でも今回の新規指摘があれば APPROVE しない', () => {
		expect(
			decideEvent(input({ approve: true, newFindings: [severity('minor')] })),
		).toBe('COMMENT');
	});

	test('bot 自身の PR には APPROVE も出さない', () => {
		expect(decideEvent(input({ approve: true, canSubmitVerdict: false }))).toBe(
			'NONE',
		);
	});

	test('outdated かどうかは判定に影響しない', () => {
		expect(
			decideEvent(input({ existing: [existing('critical', false)] })),
		).toBe('REQUEST_CHANGES');
	});
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `bun test tests/core/decision.test.ts`
Expected: FAIL（`canSubmitVerdict` / `approve` が `DecisionInput` に無い）

- [ ] **Step 3: 実装する**

`src/core/decision.ts` を丸ごと次の内容にする。

```ts
import { isAtLeastAsSevere, type Severity } from './schema';

/** Review として提出できるイベント。 */
export type ReviewEvent = 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';

/** NONE は「Review を作らない」を表す。 */
export type EventDecision = ReviewEvent | 'NONE';

export const REQUEST_CHANGES_ON_VALUES = [
	'none',
	'critical',
	'major',
	'minor',
] as const;
export type RequestChangesOn = (typeof REQUEST_CHANGES_ON_VALUES)[number];

export interface DecisionInput {
	/** 今回のレビューで新たに投稿する指摘。 */
	newFindings: readonly { severity: Severity }[];
	/** GitHub 上に既にある bot の指摘。 */
	existing: readonly { severity: Severity; isResolved: boolean }[];
	threshold: RequestChangesOn;
	/**
	 * APPROVE / REQUEST_CHANGES を提出できるか。
	 * bot 自身が作成した PR にはどちらも提出できず 422 になるため false を渡す。
	 */
	canSubmitVerdict: boolean;
	/** approve input。既定 false。 */
	approve: boolean;
}

export function decideEvent(input: DecisionInput): EventDecision {
	const unresolved = input.existing.filter(e => !e.isResolved);
	// 投稿後の未解決件数。board を組み立てる前に判定するため、ここで直接数える。
	const outstandingAfter = unresolved.length + input.newFindings.length;

	if (input.approve && input.canSubmitVerdict && outstandingAfter === 0) {
		return 'APPROVE';
	}

	if (input.threshold !== 'none' && input.canSubmitVerdict) {
		const threshold: Severity = input.threshold;
		const hasNew = input.newFindings.some(f =>
			isAtLeastAsSevere(f.severity, threshold),
		);
		const hasUnresolved = unresolved.some(e =>
			isAtLeastAsSevere(e.severity, threshold),
		);
		if (hasNew || hasUnresolved) return 'REQUEST_CHANGES';
	}

	return input.newFindings.length > 0 ? 'COMMENT' : 'NONE';
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `bun test tests/core/decision.test.ts`
Expected: PASS

- [ ] **Step 5: 型チェック（この時点では orchestrate が壊れる）**

Run: `bun run typecheck`
Expected: `src/orchestrate.ts` で `canRequestChanges` が無いという型エラー。**これは想定どおり**。Task 8 で解消する。

暫定で orchestrate をコンパイル可能に保つため、`src/orchestrate.ts:164-169` の `decideEvent` 呼び出しを次に差し替える。

```ts
const event = decideEvent({
	newFindings: toPost,
	existing,
	threshold: config.requestChangesOn,
	canSubmitVerdict: !pr.authorLogin.endsWith(BOT_AUTHOR_SUFFIX),
	approve: false,
});
```

`event` が `'NONE'` になりうるため、`github.createReview` へ渡す直前でガードを足す。Task 8 で正式なフローに置き換わる暫定コード。

```ts
await github.createReview({
	body,
	event: event === 'NONE' ? 'COMMENT' : event,
	commitId: pr.headSha,
	comments: inline,
});
```

- [ ] **Step 6: 型・lint・全テスト**

Run: `bun run typecheck && bun run lint && bun test`
Expected: 全て PASS

- [ ] **Step 7: コミット**

```bash
git add src/core/decision.ts tests/core/decision.test.ts src/orchestrate.ts
git commit -m "feat(decision): APPROVE と NONE を追加し verdict のゲートを統一"
```

---

## Task 4: `i18n.ts` と `render.ts`（sticky 本文の描画）

**Files:**

- Modify: `src/core/i18n.ts`
- Modify: `src/core/render.ts`
- Test: `tests/core/render.test.ts`

**Interfaces:**

- Consumes: `Board`, `ThreadInfo`（Task 2） / `RunRecord`, `buildStickyMarker`, `buildRunMarker`, `totalCostUsd`（Task 1）
- Produces:
  - `interface LatestRun { model: string; effort: string; seconds: number; costUsd: number; attempts: number }`
  - `interface StickyInput { lang: Language; board: Board; runs: readonly RunRecord[]; reviewedSha: string; latest: LatestRun | null; failure: string | null; oversizedFiles: readonly string[] }`
  - `renderSticky(input: StickyInput): string`
  - `renderInlineComment(finding: KeyedFinding, lang: Language): string`（既存のまま）

**このタスクは追加のみ。** `renderSummary` / `renderFailureSummary` / `SummaryInput` は**そのまま残す**。削除は Task 8 で `orchestrate.ts` が使わなくなってから行う。こうすることで、このタスクの中間コミットに暫定シムもスキップされたテストも生まれない。

`i18n.ts` の `Messages` は差し替えるため、旧 `renderSummary` / `renderFailureSummary` が参照していた文言キー（`summaryHeading`, `noFindings`, `findingsCount`, `incrementalNote`, `fullNote`, `unlocatableHeading`, `unlocatableNote`, `failureHeading`, `failureBody`, `instructionSource`）は **`Messages` に残したまま新しいキーを足す**。Task 8 で旧関数と一緒に消す。

- [ ] **Step 1: `i18n.ts` に新しい文言を足す**

`src/core/i18n.ts` を次の内容にする。**ただし既存の `Messages` のキーと `EN` / `JA` の値はすべて残したうえで**、以下のキーを追加する形にすること（旧 `renderSummary` / `renderFailureSummary` がまだ参照しているため）。残すキーは `summaryHeading` / `noFindings` / `findingsCount` / `incrementalNote` / `fullNote` / `unlocatableHeading` / `unlocatableNote` / `oversizedWarning` / `failureHeading` / `failureBody` / `errorDetails` / `instructionSource` の 12 個。`oversizedWarning` と `errorDetails` は新旧で共用するので重複させない。

Task 8 で旧関数を消すときに、残した 10 個（`oversizedWarning` と `errorDetails` を除く）も一緒に消す。

```ts
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
	errorDetails: string;
	oversizedWarning: (files: readonly string[]) => string;
	outdatedSuffix: string;
	unknownTitle: string;
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
		`This run: \`${latest.model}\` · effort \`${latest.effort}\` · ${latest.seconds}s · $${latest.costUsd.toFixed(2)}${
			latest.attempts > 1 ? ` (succeeded on attempt ${latest.attempts})` : ''
		}`,
	failureBanner: sha =>
		`> ⚠️ The automated review could not be completed. \`${sha}\` has **not** been reviewed. Re-run the workflow or check the job logs.`,
	errorDetails: 'Error details',
	oversizedWarning: files =>
		`> ⚠️ ${files.length} file(s) were skipped because the diff exceeded the size limit and were **not reviewed**: ${files
			.map(f => `\`${f}\``)
			.join(', ')}`,
	outdatedSuffix: '(outdated)',
	unknownTitle: '(title unavailable)',
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
		`今回: \`${latest.model}\` · effort \`${latest.effort}\` · ${latest.seconds}s · $${latest.costUsd.toFixed(2)}${
			latest.attempts > 1 ? `（${latest.attempts} 回目で成功）` : ''
		}`,
	failureBanner: sha =>
		`> ⚠️ 自動レビューを完了できませんでした。\`${sha}\` は未レビューです。ワークフローを再実行するか、ジョブのログを確認してください。`,
	errorDetails: 'エラー概要',
	oversizedWarning: files =>
		`> ⚠️ 差分がサイズ上限を超えたため ${files.length} 件のファイルを**レビューしていません**: ${files
			.map(f => `\`${f}\``)
			.join(', ')}`,
	outdatedSuffix: '(outdated)',
	unknownTitle: '(タイトル不明)',
};

export function messages(lang: Language): Messages {
	return lang === 'ja' ? JA : EN;
}
```

- [ ] **Step 2: 失敗するテストを書く**

`tests/core/render.test.ts` を丸ごと次の内容にする。

```ts
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
```

- [ ] **Step 3: テストが落ちることを確認**

Run: `bun test tests/core/render.test.ts`
Expected: FAIL（`renderSticky` が export されていない）

- [ ] **Step 4: `render.ts` を実装する**

`src/core/render.ts` を丸ごと次の内容にする。

````ts
import type { Board, ThreadInfo } from './board';
import type { KeyedFinding } from './dedupe';
import { type Language, type LatestRun, messages } from './i18n';
import {
	buildInlineMarker,
	buildRunMarker,
	buildStickyMarker,
	type RunRecord,
	totalCostUsd,
} from './marker';
import { SEVERITIES, type Severity } from './schema';

const SEVERITY_EMOJI: Record<Severity, string> = {
	critical: '🔴',
	major: '🟠',
	minor: '🟡',
};

const EVENT_LABEL: Record<RunRecord['event'], string | null> = {
	COMMENT: '💬 COMMENT',
	REQUEST_CHANGES: '🔴 REQUEST_CHANGES',
	APPROVE: '✅ APPROVE',
	NONE: null,
	FAILED: null,
};

/**
 * インラインコメント 1 件の本文。末尾にマーカーを埋め込む。
 * 本文はモデルが `language` に従って生成済みなので、ここでは固定文言を足さない。
 * 1 行目の書式は parseInlineTitle が読むので変更しない。
 */
export function renderInlineComment(
	finding: KeyedFinding,
	_lang: Language,
): string {
	const head = `${SEVERITY_EMOJI[finding.severity]} **${finding.severity}** — ${finding.title}`;
	const marker = buildInlineMarker(finding.key, finding.severity);
	return `${head}\n\n${finding.body.trim()}\n\n${marker}\n`;
}

export interface StickyInput {
	lang: Language;
	board: Board;
	/** 過去分 + 今回分。時系列昇順。 */
	runs: readonly RunRecord[];
	reviewedSha: string;
	/** 実行情報セクションに出す最新実行。差分ゼロで終わった回は null。 */
	latest: LatestRun | null;
	/** 失敗したときのエラー本文。成功時は null。 */
	failure: string | null;
	oversizedFiles: readonly string[];
}

export function renderSticky(input: StickyInput): string {
	const m = messages(input.lang);
	const lines: string[] = [m.heading, ''];

	if (input.failure !== null) {
		lines.push(
			m.failureBanner(input.reviewedSha),
			'>',
			`> <details><summary>${m.errorDetails}</summary>`,
			'>',
			'> ```',
			...(input.failure.trim() || '(no details)')
				.split('\n')
				.map(line => `> ${line}`),
			'> ```',
			'>',
			'> </details>',
			'',
		);
	}

	if (input.oversizedFiles.length > 0) {
		lines.push(m.oversizedWarning(input.oversizedFiles), '');
	}

	lines.push(renderStatusLine(input, m), '');

	if (input.board.outstanding.length > 0) {
		lines.push(m.outstandingHeading, '');
		for (const thread of input.board.outstanding) {
			lines.push(renderThreadLine(thread, m.unknownTitle, m.outdatedSuffix));
		}
		lines.push('');
	}

	if (input.board.resolved.length > 0) {
		lines.push(
			`<details><summary>${m.resolvedSummary(input.board.resolved.length)}</summary>`,
			'',
		);
		for (const thread of input.board.resolved) {
			lines.push(
				renderThreadLine(thread, m.unknownTitle, m.outdatedSuffix, true),
			);
		}
		lines.push('', '</details>', '');
	}

	if (input.runs.length > 0) {
		lines.push(...renderHistory(input.runs, m), '');
	}

	if (input.latest !== null) {
		lines.push(
			`<details><summary>${m.runInfoSummary}</summary>`,
			'',
			m.runInfoLine(input.latest),
			'',
			'</details>',
			'',
		);
	}

	lines.push(buildStickyMarker(input.reviewedSha));
	for (const run of input.runs) lines.push(buildRunMarker(run));

	return `${lines.join('\n').trimEnd()}\n`;
}

function renderStatusLine(
	input: StickyInput,
	m: ReturnType<typeof messages>,
): string {
	const parts = [m.reviewedUpTo(input.reviewedSha)];
	const total = input.board.outstanding.length;

	if (total === 0) {
		parts.push(m.noOutstanding);
		return parts.join(' · ');
	}

	parts.push(m.outstandingCount(total));
	const counts = SEVERITIES.filter(s => input.board.counts[s] > 0).map(
		s => `${SEVERITY_EMOJI[s]} ${input.board.counts[s]}`,
	);
	if (counts.length > 0) parts.push(counts.join(' / '));
	return parts.join(' · ');
}

function renderThreadLine(
	thread: ThreadInfo,
	unknownTitle: string,
	outdatedSuffix: string,
	strike = false,
): string {
	const title =
		thread.title === null ? unknownTitle : sanitizeTitle(thread.title);
	const link = `[${title}](${thread.url})`;
	const where =
		thread.line === null ? thread.file : `${thread.file}:${thread.line}`;
	const suffix = thread.isOutdated ? ` ${outdatedSuffix}` : '';
	return `- ${SEVERITY_EMOJI[thread.severity]} ${strike ? `~~${link}~~` : link} — \`${where}\`${suffix}`;
}

/**
 * タイトルはモデル出力で、差分の内容に影響される。sticky は編集され続ける
 * 常設コメントなので、リンクラベルを閉じられたり、偽のマーカーを仕込まれたり
 * すると壊れたまま残る。埋め込む直前に潰す。
 * < と > を実体参照にするのは、表示を変えずに <!-- --> を成立させないため。
 */
function sanitizeTitle(title: string): string {
	return title
		.replace(/\s+/g, ' ')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/([\\[\]])/g, String.raw`\$1`)
		.trim();
}

function renderHistory(
	runs: readonly RunRecord[],
	m: ReturnType<typeof messages>,
): string[] {
	const total = `$${totalCostUsd(runs).toFixed(2)}`;
	const rows = runs.map(run => {
		const range = run.mode === 'full' ? m.modeFull : m.modeIncremental;
		const verdict =
			run.event === 'FAILED' ? m.eventFailed : (EVENT_LABEL[run.event] ?? '—');
		// FAILED / NONE の回は「新規 0 件」ではなく「該当なし」を意味する。
		const newCount =
			run.event === 'FAILED' || run.event === 'NONE'
				? '—'
				: String(run.newFindings);
		return `| \`${run.commit}\` | ${range} | ${newCount} | ${verdict} | $${run.costUsd.toFixed(2)} |`;
	});

	return [
		`<details><summary>${m.historySummary(runs.length, total)}</summary>`,
		'',
		`| ${m.historyColumns.join(' | ')} |`,
		`| ${m.historyColumns.map(() => '---').join(' | ')} |`,
		...rows,
		'',
		'</details>',
	];
}
````

- [ ] **Step 5: テストが通ることを確認**

Run: `bun test tests/core/render.test.ts`
Expected: PASS

- [ ] **Step 6: 型・lint・全テスト**

Run: `bun run typecheck && bun run lint && bun test`
Expected: 全て PASS。`orchestrate.ts` は旧 `renderSummary` / `renderFailureSummary` を使い続けているので壊れない。既存の orchestrate テストも全て通ったまま。スキップするテストは 1 件も無い。

- [ ] **Step 7: コミット**

```bash
git add src/core/i18n.ts src/core/render.ts tests/core/render.test.ts
git commit -m "feat(render): sticky サマリーの描画を追加"
```

---

## Task 5: `agent.ts` の実行メトリクス

**Files:**

- Modify: `src/io/agent.ts`
- Test: `tests/io/agent-metrics.test.ts`（新規）

**Interfaces:**

- Produces:
  - `interface AgentMetrics { costUsd: number; durationMs: number }`
  - `extractMetrics(message: unknown): AgentMetrics | null`
  - `type AgentOutcome = { ok: true; findings: Finding[]; metrics: AgentMetrics } | { ok: false; error: string; metrics: AgentMetrics }`

`runAgent` は SDK を叩くので単体テストできない。メトリクス抽出を純関数 `extractMetrics` に切り出し、そこだけをテストする。

- [ ] **Step 1: 失敗するテストを書く**

`tests/io/agent-metrics.test.ts` を新規作成する。

```ts
import { describe, expect, test } from 'bun:test';
import { extractMetrics } from '../../src/io/agent';

describe('extractMetrics', () => {
	test('result メッセージからコストと所要時間を取る', () => {
		expect(
			extractMetrics({
				type: 'result',
				total_cost_usd: 0.1817,
				duration_ms: 42_000,
			}),
		).toEqual({ costUsd: 0.1817, durationMs: 42_000 });
	});

	test('result 以外は null', () => {
		expect(extractMetrics({ type: 'assistant' })).toBeNull();
	});

	test('オブジェクトでなければ null', () => {
		expect(extractMetrics(null)).toBeNull();
		expect(extractMetrics('result')).toBeNull();
	});

	test('欠けているフィールドは 0 で埋める', () => {
		expect(extractMetrics({ type: 'result' })).toEqual({
			costUsd: 0,
			durationMs: 0,
		});
	});

	test('数値でない値は 0 として扱う', () => {
		expect(
			extractMetrics({
				type: 'result',
				total_cost_usd: 'unknown',
				duration_ms: Number.NaN,
			}),
		).toEqual({ costUsd: 0, durationMs: 0 });
	});
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `bun test tests/io/agent-metrics.test.ts`
Expected: FAIL（`extractMetrics` が export されていない）

- [ ] **Step 3: 実装する**

`src/io/agent.ts` の `AgentOutcome` 定義（59-61 行目）を次に差し替える。

```ts
/**
 * Agent 実行の実測値。失敗時も返す（タイムアウトや予算超過でもコストは発生する）。
 * result メッセージが届く前に abort された場合は 0 になる。これは
 * 「コストがかからなかった」ではなく「計測できなかった」を意味する。
 */
export interface AgentMetrics {
	costUsd: number;
	durationMs: number;
}

export type AgentOutcome =
	| { ok: true; findings: Finding[]; metrics: AgentMetrics }
	| { ok: false; error: string; metrics: AgentMetrics };

/** SDK の result メッセージから実測値を取り出す。result 以外なら null。 */
export function extractMetrics(message: unknown): AgentMetrics | null {
	if (typeof message !== 'object' || message === null) return null;
	const record = message as Record<string, unknown>;
	if (record.type !== 'result') return null;
	return {
		costUsd: toFiniteNumber(record.total_cost_usd),
		durationMs: toFiniteNumber(record.duration_ms),
	};
}

function toFiniteNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
```

`runAgent` の本体を次のように変える。

1. `let captured` の下にメトリクス保持を足す。共有の定数オブジェクトを既定値にすると、呼び出し側が `metrics` を書き換えたときに全実行に波及しうるので、リテラルを直接持たせる。

```ts
let metrics: AgentMetrics = { costUsd: 0, durationMs: 0 };
```

2. メッセージループの `result` 分岐でメトリクスを拾う。

```ts
if (message.type === 'result') {
	metrics = extractMetrics(message) ?? metrics;
	input.log(`agent result: ${JSON.stringify(message).slice(0, 500)}`);
}
```

3. `catch` と各 `return` に `metrics` を足す。

```ts
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			error: timedOut ? `agent timed out after ${input.timeoutMs}ms` : detail,
			metrics,
		};
	} finally {
		clearTimeout(timer);
		session.close();
	}

	if (timedOut) {
		return {
			ok: false,
			error: `agent timed out after ${input.timeoutMs}ms`,
			metrics,
		};
	}
	if (callCount === 0) {
		return {
			ok: false,
			error: `agent did not call ${SUBMIT_TOOL_NAME}`,
			metrics,
		};
	}

	const parsed = parseFindings(captured);
	if (!parsed.ok) {
		return { ok: false, error: `invalid tool input: ${parsed.error}`, metrics };
	}
	return { ok: true, findings: parsed.value, metrics };
```

- [ ] **Step 4: テストが通ることを確認**

Run: `bun test tests/io/agent-metrics.test.ts`
Expected: PASS

- [ ] **Step 5: `src/orchestrate.ts` の初期 outcome に metrics を足す**

`AgentOutcome` に `metrics` が必須で入ったので、`src/orchestrate.ts:133` のリテラルが型エラーになる。次に差し替える。

```ts
let outcome: AgentOutcome = {
	ok: false,
	error: 'not attempted',
	metrics: { costUsd: 0, durationMs: 0 },
};
```

このタスクではここだけ直せばよい。合算とリトライ回数の記録は Task 8 の仕事なので、`spent` の導入や `attempts` の集計はここでは**やらない**。

Run: `bun run typecheck`
Expected: エラーなし

- [ ] **Step 6: `orchestrate.test.ts` のフェイク outcome に metrics を足す**

`tests/orchestrate.test.ts` の `outcomes` 配列に出てくる全ての `{ ok: true, findings: [...] }` / `{ ok: false, error: 'boom' }` に `metrics: { costUsd: 0.1, durationMs: 1000 }` を足す。`setup` の既定値も同様。

```ts
			runAgent: async input => {
				prompts.push(input.prompt);
				return (
					outcomes.shift() ?? {
						ok: true,
						findings: [],
						metrics: { costUsd: 0, durationMs: 0 },
					}
				);
			},
```

- [ ] **Step 7: 型・lint・全テスト**

Run: `bun run typecheck && bun run lint && bun test`
Expected: 全て PASS

- [ ] **Step 8: コミット**

```bash
git add src/io/agent.ts src/orchestrate.ts tests/io/agent-metrics.test.ts tests/orchestrate.test.ts
git commit -m "feat(agent): 実行コストと所要時間を呼び出し側へ返す"
```

---

## Task 6: `github.ts` の拡張（sticky / スレッド詳細 / ファイル単位コメント / dismiss）

**Files:**

- Modify: `src/io/github.ts`
- Modify: `src/core/dedupe.ts`

**Interfaces:**

- Consumes: `ThreadInfo`（Task 2） / `hasStickyMarker`, `parseInlineTitle`, `parseInlineMarker`（Task 1） / `ReviewEvent`（Task 3）
- Produces（`GitHubClient`）:
  - `getPullRequest(): Promise<PullRequestInfo>`（既存）
  - `getDiff(from: string, to: string): Promise<string>`（既存）
  - `listThreads(): Promise<ThreadInfo[]>`（`listExistingFindings` を置き換え）
  - `findSticky(): Promise<{ commentId: number; body: string } | null>`
  - `upsertSticky(input: { commentId: number | null; body: string }): Promise<void>`
  - `createReview(input: CreateReviewInput): Promise<void>`（`event: ReviewEvent`、`comments` に `line: number | null`）
  - `dismissOwnApproval(message: string): Promise<void>`
  - `getLastReviewedCommit` は削除する

`dedupe.ts` の `ExistingFinding` 型を削除し、`dedupe()` の第 2 引数を `readonly { key: string }[]` にする。

- [ ] **Step 1: `subject_type` が使えるか確認する**

Run:

```bash
grep -n "subject_type" node_modules/@octokit/openapi-types/types.d.ts | head -20
```

`pulls/create-review` のリクエストボディ側に `subject_type` が現れるかを見る。**現れない場合**（`pulls/create-review-comment` 側にしか無い場合）は、Step 4 の「ファイル単位コメント」を `createReview` とは別に `pulls.createReviewComment` で投稿する実装にする。両方の実装をこの Step で分岐させる。

確認結果を `docs/superpowers/specs/2026-08-09-sticky-summary-design.md` の「要検証」の箇所に追記して、未確定事項を潰す。

- [ ] **Step 2: `dedupe.ts` を書き換える**

```ts
import { findingKey } from './marker';
import type { Finding } from './schema';

export interface KeyedFinding extends Finding {
	key: string;
}

export interface DedupeResult {
	toPost: KeyedFinding[];
	alreadyPosted: KeyedFinding[];
}

/**
 * 新規指摘を既存スレッドと突き合わせ、まだ投稿していないものだけを返す。
 * resolve 済み・outdated でも再投稿はしない（人間の判断を蒸し返さない）。
 */
export function dedupe(
	findings: readonly Finding[],
	existing: readonly { key: string }[],
): DedupeResult {
	const existingKeys = new Set(existing.map(e => e.key));
	const seen = new Set<string>();

	const toPost: KeyedFinding[] = [];
	const alreadyPosted: KeyedFinding[] = [];

	for (const finding of findings) {
		const key = findingKey(finding.file, finding.title);
		if (seen.has(key)) continue;
		seen.add(key);

		const keyed: KeyedFinding = { ...finding, key };
		if (existingKeys.has(key)) alreadyPosted.push(keyed);
		else toPost.push(keyed);
	}

	return { toPost, alreadyPosted };
}
```

`tests/core/dedupe.test.ts` が `ExistingFinding` を import していれば、`{ key: string }` のリテラルに置き換える。

- [ ] **Step 3: `github.ts` を書き換える**

`src/io/github.ts` を丸ごと次の内容にする。

```ts
import { getOctokit } from '@actions/github';
import type { ThreadInfo } from '../core/board';
import type { ReviewEvent } from '../core/decision';
import {
	hasStickyMarker,
	parseInlineMarker,
	parseInlineTitle,
} from '../core/marker';

export interface PullRequestInfo {
	baseSha: string;
	headSha: string;
	title: string;
	number: number;
	authorLogin: string;
	isFork: boolean;
	isDraft: boolean;
}

export interface InlineCommentInput {
	path: string;
	/** null なら行ではなくファイル全体へのコメントにする。 */
	line: number | null;
	body: string;
}

export interface CreateReviewInput {
	body: string;
	event: ReviewEvent;
	commitId: string;
	comments: readonly InlineCommentInput[];
}

export interface GitHubClient {
	getPullRequest(): Promise<PullRequestInfo>;
	getDiff(from: string, to: string): Promise<string>;
	listThreads(): Promise<ThreadInfo[]>;
	/** この Action の sticky コメント。無ければ null。 */
	findSticky(): Promise<{ commentId: number; body: string } | null>;
	upsertSticky(input: {
		commentId: number | null;
		body: string;
	}): Promise<void>;
	createReview(input: CreateReviewInput): Promise<void>;
	/** 自分が過去に出した APPROVE を取り下げる。無ければ何もしない。 */
	dismissOwnApproval(message: string): Promise<void>;
}

export interface GitHubClientOptions {
	token: string;
	owner: string;
	repo: string;
	prNumber: number;
}

interface ReviewThreadsResponse {
	repository: {
		pullRequest: {
			reviewThreads: {
				pageInfo: { hasNextPage: boolean; endCursor: string | null };
				nodes: {
					isResolved: boolean;
					isOutdated: boolean;
					path: string;
					line: number | null;
					comments: { nodes: { body: string; url: string }[] };
				}[];
			};
		};
	};
}

const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
	repository(owner: $owner, name: $repo) {
		pullRequest(number: $number) {
			reviewThreads(first: 100, after: $cursor) {
				pageInfo { hasNextPage endCursor }
				nodes {
					isResolved
					isOutdated
					path
					line
					comments(first: 1) { nodes { body url } }
				}
			}
		}
	}
}`;

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
	const octokit = getOctokit(options.token);
	const { owner, repo, prNumber } = options;

	/**
	 * このトークンが名乗る identity。sticky を騙るコメントを他人が投稿できると
	 * reviewed を head まで進められてレビューを丸ごとスキップさせられるため、
	 * 作成者を必ず確認する。GITHUB_TOKEN では getAuthenticated が 403 になるので
	 * その場合は Bot 判定にフォールバックする。
	 */
	let selfLogin: string | null | undefined;
	const resolveSelfLogin = async (): Promise<string | null> => {
		if (selfLogin !== undefined) return selfLogin;
		try {
			const { data } = await octokit.rest.users.getAuthenticated();
			selfLogin = data.login;
		} catch {
			selfLogin = null;
		}
		return selfLogin;
	};

	const isOwnComment = (
		user: { login?: string; type?: string } | null | undefined,
		login: string | null,
	): boolean => (login === null ? user?.type === 'Bot' : user?.login === login);

	return {
		async getPullRequest() {
			const { data } = await octokit.rest.pulls.get({
				owner,
				repo,
				pull_number: prNumber,
			});
			return {
				baseSha: data.base.sha,
				headSha: data.head.sha,
				title: data.title,
				number: data.number,
				authorLogin: data.user?.login ?? '',
				isFork: data.head.repo?.full_name !== `${owner}/${repo}`,
				isDraft: data.draft ?? false,
			};
		},

		async getDiff(from, to) {
			const response = await octokit.rest.repos.compareCommitsWithBasehead({
				owner,
				repo,
				basehead: `${from}...${to}`,
				mediaType: { format: 'diff' },
			});
			// mediaType: diff のとき data は文字列になる。
			return response.data as unknown as string;
		},

		async listThreads() {
			const threads: ThreadInfo[] = [];
			let cursor: string | null = null;

			for (;;) {
				const response: ReviewThreadsResponse = await octokit.graphql(
					REVIEW_THREADS_QUERY,
					{ owner, repo, number: prNumber, cursor },
				);
				const page = response.repository.pullRequest.reviewThreads;

				for (const thread of page.nodes) {
					const comment = thread.comments.nodes[0];
					if (!comment) continue;
					const marker = parseInlineMarker(comment.body);
					if (!marker) continue;
					threads.push({
						key: marker.key,
						severity: marker.severity,
						title: parseInlineTitle(comment.body),
						file: thread.path,
						line: thread.line,
						url: comment.url,
						isResolved: thread.isResolved,
						isOutdated: thread.isOutdated,
					});
				}

				if (!page.pageInfo.hasNextPage) break;
				cursor = page.pageInfo.endCursor;
			}

			return threads;
		},

		async findSticky() {
			const login = await resolveSelfLogin();
			const comments = await octokit.paginate(
				octokit.rest.issues.listComments,
				{
					owner,
					repo,
					issue_number: prNumber,
					per_page: 100,
				},
			);

			for (const comment of comments) {
				const body = comment.body ?? '';
				if (!hasStickyMarker(body)) continue;
				if (!isOwnComment(comment.user, login)) continue;
				return { commentId: comment.id, body };
			}
			return null;
		},

		async upsertSticky({ commentId, body }) {
			if (commentId === null) {
				await octokit.rest.issues.createComment({
					owner,
					repo,
					issue_number: prNumber,
					body,
				});
				return;
			}
			await octokit.rest.issues.updateComment({
				owner,
				repo,
				comment_id: commentId,
				body,
			});
		},

		async createReview(input) {
			await octokit.rest.pulls.createReview({
				owner,
				repo,
				pull_number: prNumber,
				commit_id: input.commitId,
				body: input.body,
				event: input.event,
				comments: input.comments.map(comment =>
					comment.line === null
						? {
								path: comment.path,
								body: comment.body,
								subject_type: 'file' as const,
							}
						: {
								path: comment.path,
								line: comment.line,
								side: 'RIGHT' as const,
								body: comment.body,
							},
				),
			});
		},

		async dismissOwnApproval(message) {
			const login = await resolveSelfLogin();
			const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
				owner,
				repo,
				pull_number: prNumber,
				per_page: 100,
			});

			for (let i = reviews.length - 1; i >= 0; i -= 1) {
				const review = reviews[i]!;
				if (!isOwnComment(review.user, login)) continue;
				// COMMENTED は承認状態を上書きしない。GitHub は各レビュアーの
				// 「最新の APPROVED / CHANGES_REQUESTED」を見るので、間に
				// COMMENTED を挟んでも前の APPROVED は生きている。読み飛ばす。
				if (review.state === 'COMMENTED' || review.state === 'DISMISSED') {
					continue;
				}
				// ここに来るのは APPROVED か CHANGES_REQUESTED。後者なら
				// 取り下げる承認は無い。
				if (review.state !== 'APPROVED') return;
				await octokit.rest.pulls.dismissReview({
					owner,
					repo,
					pull_number: prNumber,
					review_id: review.id,
					message,
				});
				return;
			}
		},
	};
}
```

**Step 1 で `subject_type` が `pulls/create-review` に無かった場合**、`createReview` を次に差し替える。

```ts
		async createReview(input) {
			const inline = input.comments.filter(c => c.line !== null);
			const fileLevel = input.comments.filter(c => c.line === null);

			await octokit.rest.pulls.createReview({
				owner,
				repo,
				pull_number: prNumber,
				commit_id: input.commitId,
				body: input.body,
				event: input.event,
				comments: inline.map(comment => ({
					path: comment.path,
					line: comment.line as number,
					side: 'RIGHT' as const,
					body: comment.body,
				})),
			});

			// createReview の comments[] は subject_type を受け付けないため、
			// ファイル単位コメントだけは個別に投稿する。
			for (const comment of fileLevel) {
				await octokit.rest.pulls.createReviewComment({
					owner,
					repo,
					pull_number: prNumber,
					commit_id: input.commitId,
					path: comment.path,
					body: comment.body,
					subject_type: 'file',
				});
			}
		},
```

- [ ] **Step 4: 型・lint**

Run: `bun run typecheck`
Expected: `src/orchestrate.ts` と `tests/orchestrate.test.ts` で `listExistingFindings` / `getLastReviewedCommit` が無いという型エラー。**Task 8 で解消する**ので、ここでは `src/orchestrate.ts` を最小限だけ追従させる。

- `github.getLastReviewedCommit()` の呼び出しを `(await github.findSticky())` から `parseStickyMarker` で読む形に置き換える（Task 8 で整理するので暫定でよい）
- `github.listExistingFindings()` を `github.listThreads()` に置き換える

`tests/orchestrate.test.ts` の `setup` のフェイクも同様に追従させる。

```ts
const github: GitHubClient = {
	getPullRequest: async () => ({ ...PR, ...options.pr }),
	getDiff: async (from, to) => {
		diffRequests.push({ from, to });
		return options.diff ?? DIFF;
	},
	listThreads: async () => options.threads ?? [],
	findSticky: async () =>
		options.lastReviewed
			? { commentId: 1, body: buildStickyMarker(options.lastReviewed) }
			: null,
	upsertSticky: async input => {
		stickyWrites.push(input);
	},
	createReview: async input => {
		reviews.push(input);
	},
	dismissOwnApproval: async message => {
		dismissals.push(message);
	},
};
```

`FakeOptions` の `existing` を `threads?: ThreadInfo[]` に改名し、`existing` を使っている 2 件のテストを `ThreadInfo` のリテラルに書き換える。

```ts
test('既存と重複する指摘は再投稿しない', async () => {
	const f = finding();
	const { deps, reviews } = setup({
		outcomes: [
			{ ok: true, findings: [f], metrics: { costUsd: 0, durationMs: 0 } },
		],
		threads: [
			{
				key: findingKey(f.file, f.title),
				severity: 'major',
				title: f.title,
				file: f.file,
				line: f.line,
				url: 'https://example.test/1',
				isResolved: false,
				isOutdated: false,
			},
		],
	});
	await runReview(deps, CONFIG);
	expect(reviews[0]?.comments ?? []).toHaveLength(0);
});
```

- [ ] **Step 5: 型・lint・全テスト**

Run: `bun run typecheck && bun run lint && bun test`
Expected: 全て PASS（Task 4 で skip した 3 件は skip のまま）

- [ ] **Step 6: コミット**

```bash
git add src/io/github.ts src/core/dedupe.ts tests/ docs/
git commit -m "feat(github): sticky コメントとスレッド詳細の取得を追加"
```

---

## Task 7: `approve` input と コスト output の配線

**Files:**

- Modify: `src/config.ts`
- Modify: `action.yml`
- Modify: `src/main.ts`
- Test: `tests/config.test.ts`

**Interfaces:**

- Produces: `Config.approve: boolean` / `RunResult.costUsd: number` / `RunResult.totalCostUsd: number`

`RunResult` への 2 フィールド追加は Task 8 で実装するが、`main.ts` の配線はここで済ませておくと Task 8 が orchestrate 1 ファイルに集中できる。**このタスクでは `RunResult` にフィールドを足すところまでやる**（値は 0 固定でよい。Task 8 で埋める）。

- [ ] **Step 1: 失敗するテストを書く**

`tests/config.test.ts` に追記する。

```ts
describe('approve', () => {
	test('既定は false', () => {
		const result = loadConfig(VALID);
		if (!result.ok) throw new Error('expected ok');
		expect(result.value.approve).toBe(false);
	});

	test('true を指定すると有効になる', () => {
		const result = loadConfig({ ...VALID, approve: 'true' });
		if (!result.ok) throw new Error('expected ok');
		expect(result.value.approve).toBe(true);
	});

	test('不正な値は false として扱う', () => {
		const result = loadConfig({ ...VALID, approve: 'maybe' });
		if (!result.ok) throw new Error('expected ok');
		expect(result.value.approve).toBe(false);
	});
});
```

`VALID` は `tests/config.test.ts` の先頭に既にある入力リテラル。新しくヘルパを作らず、既存テストと同じ書き方に合わせること。

- [ ] **Step 2: テストが落ちることを確認**

Run: `bun test tests/config.test.ts`
Expected: FAIL（`approve` が `Config` に無い）

- [ ] **Step 3: `config.ts` を変更する**

`Config` インターフェースの `requestChangesOn` の下に足す。

```ts
approve: boolean;
```

`loadConfig` の戻り値、`failOnIncomplete` の下に足す。

```ts
			approve: bool(input, 'approve', false),
```

- [ ] **Step 4: `action.yml` を変更する**

`inputs` の `request-changes-on` の直後に足す。

```yaml
approve:
  description: 'Submit the review as APPROVE when the pull request has no outstanding findings. Off by default; a bot approval must not be relied on as a branch-protection gate.'
  required: false
  default: 'false'
```

`outputs` の `review-event` の description を差し替える。

```yaml
review-event:
  description: 'COMMENT, REQUEST_CHANGES, APPROVE, or NONE'
  value: ${{ steps.review.outputs['review-event'] }}
```

`outputs` の `incomplete-files` の後に足す。

```yaml
cost-usd:
  description: 'Cost of this run in USD, summed across retries'
  value: ${{ steps.review.outputs['cost-usd'] }}
total-cost-usd:
  description: 'Cumulative cost of every review run on this pull request in USD'
  value: ${{ steps.review.outputs['total-cost-usd'] }}
```

`runs.steps[1].env` の `INPUT_REQUEST-CHANGES-ON` の直後に足す。

```yaml
INPUT_APPROVE: ${{ inputs.approve }}
```

- [ ] **Step 5: `main.ts` を変更する**

`INPUT_KEYS` の `'request-changes-on',` の直後に `'approve',` を足す。

`core.setOutput` の並びに足す。

```ts
core.setOutput('cost-usd', result.costUsd.toFixed(4));
core.setOutput('total-cost-usd', result.totalCostUsd.toFixed(4));
```

- [ ] **Step 6: `orchestrate.ts` の `RunResult` に 2 フィールド足す**

```ts
export interface RunResult {
	status: 'success' | 'failed';
	event: EventDecision;
	counts: Record<Severity, number>;
	findingsCount: number;
	incompleteFiles: number;
	/** この実行のコスト（全 attempt 合計）。 */
	costUsd: number;
	/** PR 全体の累計コスト。 */
	totalCostUsd: number;
	error: string | null;
}
```

`aborted` と各 `return` に `costUsd: 0, totalCostUsd: 0` を足してコンパイルを通す。Task 8 で実際の値を入れる。

- [ ] **Step 7: 型・lint・全テスト**

Run: `bun run typecheck && bun run lint && bun test`
Expected: 全て PASS

- [ ] **Step 8: コミット**

```bash
git add src/config.ts action.yml src/main.ts src/orchestrate.ts tests/config.test.ts
git commit -m "feat(config): approve input とコスト output を追加"
```

---

## Task 8: `orchestrate.ts` の成功パス

**Files:**

- Modify: `src/orchestrate.ts`
- Modify: `src/core/marker.ts`（`SUMMARY_MARKER` / `FAILURE_MARKER` / `hasSummaryMarker` / `hasFailureMarker` を削除）
- Modify: `tests/core/marker.test.ts`（削除した関数のテストを消す）
- Test: `tests/orchestrate.test.ts`

**Interfaces:**

- Consumes: Task 1〜7 の全て
- Produces: `runReview(deps, config): Promise<RunResult>`（フロー全体）

- [ ] **Step 1: 失敗するテストを書く**

`tests/orchestrate.test.ts` に追記する（Task 4 で skip した 3 件のうち、サマリ落ちの 2 件は削除する。ファイル単位コメントに変わったため）。

```ts
test('行を特定できない指摘はファイル単位コメントとして投稿する', async () => {
	const { deps, reviews } = setup({
		outcomes: [
			{
				ok: true,
				findings: [finding({ line: null })],
				metrics: { costUsd: 0, durationMs: 0 },
			},
		],
	});
	await runReview(deps, CONFIG);
	expect(reviews[0]!.comments).toHaveLength(1);
	expect(reviews[0]!.comments[0]!.line).toBeNull();
	expect(reviews[0]!.comments[0]!.path).toBe('src/a.ts');
});

test('差分に無い行の指摘もファイル単位コメントにする', async () => {
	const { deps, reviews } = setup({
		outcomes: [
			{
				ok: true,
				findings: [finding({ line: 999 })],
				metrics: { costUsd: 0, durationMs: 0 },
			},
		],
	});
	await runReview(deps, CONFIG);
	expect(reviews[0]!.comments[0]!.line).toBeNull();
});

test('差分に無いファイルの指摘は破棄する', async () => {
	const { deps, reviews } = setup({
		outcomes: [
			{
				ok: true,
				findings: [finding({ file: 'src/other.ts' })],
				metrics: { costUsd: 0, durationMs: 0 },
			},
		],
	});
	const result = await runReview(deps, CONFIG);
	expect(reviews).toHaveLength(0);
	expect(result.findingsCount).toBe(0);
});

test('指摘ゼロなら Review を作らず sticky だけ更新する', async () => {
	const { deps, reviews, stickyWrites } = setup();
	const result = await runReview(deps, CONFIG);
	expect(reviews).toHaveLength(0);
	expect(stickyWrites).toHaveLength(1);
	expect(result.event).toBe('NONE');
	expect(result.status).toBe('success');
});

test('sticky に head sha を書き込む', async () => {
	const { deps, stickyWrites } = setup();
	await runReview(deps, CONFIG);
	expect(stickyWrites[0]!.body).toContain(
		'<!-- review-bot:v1 sticky reviewed=head -->',
	);
});

test('sticky が無ければ新規作成する', async () => {
	const { deps, stickyWrites } = setup();
	await runReview(deps, CONFIG);
	expect(stickyWrites[0]!.commentId).toBeNull();
});

test('sticky があれば同じコメントを更新する', async () => {
	const { deps, stickyWrites } = setup({ lastReviewed: 'prev' });
	await runReview(deps, CONFIG);
	expect(stickyWrites[0]!.commentId).toBe(1);
});

test('run マーカーを追記し、過去分を残す', async () => {
	const { deps, stickyWrites } = setup({
		sticky: {
			commentId: 1,
			body: `${buildStickyMarker('prev')}\n${buildRunMarker({
				commit: 'prev',
				mode: 'auto',
				newFindings: 2,
				event: 'COMMENT',
				costUsd: 0.5,
				seconds: 30,
				attempts: 1,
				model: 'claude-sonnet-5',
				effort: 'high',
			})}`,
		},
	});
	await runReview(deps, CONFIG);
	const runs = parseRunMarkers(stickyWrites[0]!.body);
	expect(runs.map(r => r.commit)).toEqual(['prev', 'head']);
});

test('コストを合算して返す', async () => {
	const { deps } = setup({
		outcomes: [
			{
				ok: false,
				error: 'boom',
				metrics: { costUsd: 0.1, durationMs: 1000 },
			},
			{
				ok: true,
				findings: [],
				metrics: { costUsd: 0.2, durationMs: 2000 },
			},
		],
	});
	const result = await runReview(deps, CONFIG);
	expect(result.costUsd).toBeCloseTo(0.3, 4);
});

test('リトライ回数を run マーカーに書く', async () => {
	const { deps, stickyWrites } = setup({
		outcomes: [
			{
				ok: false,
				error: 'boom',
				metrics: { costUsd: 0.1, durationMs: 1000 },
			},
			{
				ok: true,
				findings: [],
				metrics: { costUsd: 0.2, durationMs: 2000 },
			},
		],
	});
	await runReview(deps, CONFIG);
	expect(parseRunMarkers(stickyWrites[0]!.body)[0]!.attempts).toBe(2);
});

test('累計コストは過去の run マーカーを含む', async () => {
	const { deps } = setup({
		sticky: {
			commentId: 1,
			body: `${buildStickyMarker('prev')}\n${buildRunMarker({
				commit: 'prev',
				mode: 'auto',
				newFindings: 0,
				event: 'NONE',
				costUsd: 0.5,
				seconds: 10,
				attempts: 1,
				model: 'm',
				effort: 'high',
			})}`,
		},
		outcomes: [
			{
				ok: true,
				findings: [],
				metrics: { costUsd: 0.25, durationMs: 1000 },
			},
		],
	});
	const result = await runReview(deps, CONFIG);
	expect(result.totalCostUsd).toBeCloseTo(0.75, 4);
});

test('approve が有効で未解決ゼロなら APPROVE を出す', async () => {
	const { deps, reviews } = setup();
	const result = await runReview(deps, { ...CONFIG, approve: true });
	expect(result.event).toBe('APPROVE');
	expect(reviews[0]!.event).toBe('APPROVE');
});

test('sticky の upsert が失敗してもレビューは成功扱い', async () => {
	const { deps } = setup({ stickyWriteError: new Error('rate limited') });
	const result = await runReview(deps, CONFIG);
	expect(result.status).toBe('success');
});

test('想定外の例外も sticky に失敗バナーとして残す', async () => {
	const { deps, stickyWrites, reviews } = setup({
		diffError: new Error('502 from GitHub'),
	});
	const result = await runReview(deps, CONFIG);
	expect(result.status).toBe('failed');
	expect(result.error).toContain('502 from GitHub');
	expect(reviews).toHaveLength(0);
	expect(stickyWrites).toHaveLength(1);
	expect(stickyWrites[0]!.body).toContain('502 from GitHub');
	expect(parseRunMarkers(stickyWrites[0]!.body)[0]!.event).toBe('FAILED');
});

test('sticky を特定できないまま失敗したら sticky を書かない', async () => {
	// findSticky が失敗した状態で新規作成すると sticky が二重になる。
	const { deps, stickyWrites } = setup({
		stickyLookupError: new Error('403'),
	});
	const result = await runReview(deps, CONFIG);
	expect(result.status).toBe('failed');
	expect(stickyWrites).toHaveLength(0);
});

test('board の再取得結果を sticky に描く', async () => {
	const { deps, stickyWrites } = setup({
		threadsAfterReview: [
			{
				key: 'b'.repeat(12),
				severity: 'critical',
				title: '再取得で見えた指摘',
				file: 'src/a.ts',
				line: 2,
				url: 'https://example.test/9',
				isResolved: false,
				isOutdated: false,
			},
		],
	});
	await runReview(deps, CONFIG);
	expect(stickyWrites[0]!.body).toContain('再取得で見えた指摘');
});
```

`setup` を次のように拡張する。

```ts
interface FakeOptions {
	pr?: Partial<PullRequestInfo>;
	lastReviewed?: string | null;
	sticky?: { commentId: number; body: string } | null;
	diff?: string;
	threads?: ThreadInfo[];
	/** createReview 後の再取得で返すスレッド。未指定なら threads と同じ。 */
	threadsAfterReview?: ThreadInfo[];
	outcomes?: AgentOutcome[];
	instructions?: string | null;
	stickyWriteError?: Error;
	/** getDiff を失敗させて想定外の例外経路を試す。 */
	diffError?: Error;
	/** findSticky を失敗させて「sticky を特定できない」経路を試す。 */
	stickyLookupError?: Error;
}

function setup(options: FakeOptions = {}) {
	const reviews: CreateReviewInput[] = [];
	const prompts: string[] = [];
	const diffRequests: { from: string; to: string }[] = [];
	const stickyWrites: { commentId: number | null; body: string }[] = [];
	const dismissals: string[] = [];
	const outcomes = [...(options.outcomes ?? [])];

	const sticky =
		options.sticky ??
		(options.lastReviewed
			? { commentId: 1, body: buildStickyMarker(options.lastReviewed) }
			: null);

	let threadCalls = 0;

	const github: GitHubClient = {
		getPullRequest: async () => ({ ...PR, ...options.pr }),
		getDiff: async (from, to) => {
			diffRequests.push({ from, to });
			if (options.diffError) throw options.diffError;
			return options.diff ?? DIFF;
		},
		listThreads: async () => {
			threadCalls += 1;
			if (threadCalls > 1 && options.threadsAfterReview) {
				return options.threadsAfterReview;
			}
			return options.threads ?? [];
		},
		findSticky: async () => {
			if (options.stickyLookupError) throw options.stickyLookupError;
			return sticky;
		},
		upsertSticky: async input => {
			if (options.stickyWriteError) throw options.stickyWriteError;
			stickyWrites.push(input);
		},
		createReview: async input => {
			reviews.push(input);
		},
		dismissOwnApproval: async message => {
			dismissals.push(message);
		},
	};

	const deps: OrchestrateDeps = {
		github,
		runAgent: async input => {
			prompts.push(input.prompt);
			return (
				outcomes.shift() ?? {
					ok: true,
					findings: [],
					metrics: { costUsd: 0, durationMs: 0 },
				}
			);
		},
		readInstructions: async () => options.instructions ?? null,
		log: () => {},
	};

	return { deps, reviews, prompts, diffRequests, stickyWrites, dismissals };
}
```

`CONFIG` に `approve: false` を足す。

- [ ] **Step 2: テストが落ちることを確認**

Run: `bun test tests/orchestrate.test.ts`
Expected: FAIL

- [ ] **Step 3: `orchestrate.ts` を実装する**

`src/orchestrate.ts` を丸ごと次の内容にする。

```ts
import type { Config } from './config';
import { buildBoard } from './core/board';
import { decideEvent, type EventDecision } from './core/decision';
import { dedupe, type KeyedFinding } from './core/dedupe';
import { analyzeDiff, isCommentable } from './core/diff';
import type { LatestRun } from './core/i18n';
import {
	buildRunMarker,
	parseRunMarkers,
	parseStickyMarker,
	type RunRecord,
	totalCostUsd,
} from './core/marker';
import { buildPrompt, DEFAULT_INSTRUCTIONS } from './core/prompt';
import { renderInlineComment, renderSticky } from './core/render';
import type { Severity } from './core/schema';
import {
	type AgentMetrics,
	type AgentOutcome,
	SUBMIT_TOOL_NAME,
} from './io/agent';
import type {
	GitHubClient,
	InlineCommentInput,
	PullRequestInfo,
} from './io/github';

export interface AgentRunRequest {
	prompt: string;
}

export interface OrchestrateDeps {
	github: GitHubClient;
	runAgent(input: AgentRunRequest): Promise<AgentOutcome>;
	/** instructions-file を読む。存在しなければ null。 */
	readInstructions(path: string): Promise<string | null>;
	log(message: string): void;
}

export interface RunResult {
	status: 'success' | 'failed';
	event: EventDecision;
	counts: Record<Severity, number>;
	findingsCount: number;
	incompleteFiles: number;
	costUsd: number;
	totalCostUsd: number;
	error: string | null;
}

const BOT_AUTHOR_SUFFIX = '[bot]';

const DISMISS_MESSAGE =
	'The automated review could not be completed, so this approval is no longer valid.';

export async function runReview(
	deps: OrchestrateDeps,
	config: Config,
): Promise<RunResult> {
	const { github, log } = deps;

	const emptyCounts = (): Record<Severity, number> => ({
		critical: 0,
		major: 0,
		minor: 0,
	});

	let pr: PullRequestInfo;
	try {
		pr = await github.getPullRequest();
	} catch (error) {
		const message = `could not fetch pull request: ${describe(error)}`;
		log(message);
		return {
			status: 'failed',
			event: 'NONE',
			counts: emptyCounts(),
			findingsCount: 0,
			incompleteFiles: 0,
			costUsd: 0,
			totalCostUsd: 0,
			error: message,
		};
	}

	if (pr.isFork) {
		// fork PR では GITHUB_TOKEN が read-only になり投稿できない。
		// 失敗通知すら投稿できないので API 呼び出しを試みない。
		const error =
			'this pull request comes from a fork; GITHUB_TOKEN is read-only and the review cannot be posted';
		log(error);
		return {
			status: 'failed',
			event: 'NONE',
			counts: emptyCounts(),
			findingsCount: 0,
			incompleteFiles: 0,
			costUsd: 0,
			totalCostUsd: 0,
			error,
		};
	}

	// 失敗経路と成功経路で共有する状態。abort() が途中までの値を使って
	// sticky を書けるよう、try の外で持つ。
	let sticky: { commentId: number; body: string } | null = null;
	let stickyResolved = false;
	let previousRuns: RunRecord[] = [];
	let lastReviewed: string | null = null;
	let oversizedFiles: readonly string[] = [];
	const spent: AgentMetrics = { costUsd: 0, durationMs: 0 };
	let attempts = 0;

	/** sticky を書く。失敗してもレビュー自体は落とさない。 */
	const writeSticky = async (input: {
		reviewedSha: string;
		runs: readonly RunRecord[];
		board: Board;
		latest: LatestRun | null;
		failure: string | null;
	}): Promise<void> => {
		// findSticky に失敗していると既存コメントの id が分からない。ここで
		// 新規作成すると sticky が二重になるので、何もせず記録だけ残す。
		if (!stickyResolved) {
			log('skipped the summary comment: the existing one could not be located');
			return;
		}
		try {
			await github.upsertSticky({
				commentId: sticky?.commentId ?? null,
				body: renderSticky({ lang: config.language, oversizedFiles, ...input }),
			});
		} catch (error) {
			// reviewed が進まないので次回同じ範囲を再レビューするが、
			// dedupe があるので二重投稿にはならない。安全側に倒れる。
			log(`could not update the summary comment: ${describe(error)}`);
		}
	};

	const latestRun = (): LatestRun => ({
		model: config.model,
		effort: config.effort,
		seconds: Math.round(spent.durationMs / 1000),
		costUsd: spent.costUsd,
		attempts: Math.max(attempts, 1),
	});

	const record = (
		event: RunRecord['event'],
		newFindings: number,
	): RunRecord[] => [
		...previousRuns,
		{
			commit: pr.headSha,
			mode: config.mode,
			newFindings,
			event,
			costUsd: spent.costUsd,
			seconds: Math.round(spent.durationMs / 1000),
			attempts: Math.max(attempts, 1),
			model: config.model,
			effort: config.effort,
		},
	];

	/** 失敗を sticky に残して RunResult を返す共通経路。 */
	const abort = async (error: string): Promise<RunResult> => {
		log(`review failed: ${error}`);
		const runs = record('FAILED', 0);

		// 古い APPROVE が残ると PR が緑に見える。fail-on-error が防ごうとしている
		// 状況そのものなので取り下げる。
		try {
			await github.dismissOwnApproval(DISMISS_MESSAGE);
		} catch (dismissError) {
			log(`could not dismiss the stale approval: ${describe(dismissError)}`);
		}

		// スレッド取得も失敗しうる。バナーだけでも残す方が無言より良い。
		let board = buildBoard([]);
		try {
			board = buildBoard(await github.listThreads());
		} catch (threadError) {
			log(`could not list review threads: ${describe(threadError)}`);
		}

		await writeSticky({
			// 失敗した範囲を二度とレビューしないことになるので reviewed は進めない。
			reviewedSha: lastReviewed ?? pr.baseSha,
			runs,
			board,
			latest: latestRun(),
			failure: error,
		});

		return {
			status: 'failed',
			event: 'NONE',
			counts: emptyCounts(),
			findingsCount: 0,
			incompleteFiles: oversizedFiles.length,
			costUsd: spent.costUsd,
			totalCostUsd: totalCostUsd(runs),
			error,
		};
	};

	try {
		sticky = await github.findSticky();
		stickyResolved = true;
		previousRuns = sticky ? parseRunMarkers(sticky.body) : [];
		lastReviewed = sticky
			? (parseStickyMarker(sticky.body)?.reviewed ?? null)
			: null;

		const from =
			config.mode === 'full' ? pr.baseSha : (lastReviewed ?? pr.baseSha);
		log(`reviewing ${from}...${pr.headSha} (mode=${config.mode})`);

		const rawDiff = await github.getDiff(from, pr.headSha);
		const analysis = analyzeDiff(rawDiff, {
			exclude: config.exclude,
			maxBytes: config.diffMaxBytes,
		});
		oversizedFiles = analysis.oversizedFiles;

		if (analysis.text.trim() === '') {
			log('no reviewable changes');
			await writeSticky({
				reviewedSha: pr.headSha,
				runs: previousRuns,
				board: buildBoard(await github.listThreads()),
				latest: null,
				failure: null,
			});
			return {
				status: 'success',
				event: 'NONE',
				counts: emptyCounts(),
				findingsCount: 0,
				incompleteFiles: oversizedFiles.length,
				costUsd: 0,
				totalCostUsd: totalCostUsd(previousRuns),
				error: null,
			};
		}

		const instructions =
			(await deps.readInstructions(config.instructionsFile)) ??
			DEFAULT_INSTRUCTIONS;

		const prompt = buildPrompt({
			instructions,
			repo: config.repo,
			prNumber: pr.number,
			prTitle: pr.title,
			diff: analysis.text,
			lang: config.language,
			oversizedFiles: analysis.oversizedFiles,
			toolName: SUBMIT_TOOL_NAME,
		});

		let outcome: AgentOutcome = {
			ok: false,
			error: 'not attempted',
			metrics: { costUsd: 0, durationMs: 0 },
		};

		for (let attempt = 1; attempt <= config.maxRetries; attempt += 1) {
			attempts = attempt;
			log(`agent attempt ${attempt}/${config.maxRetries}`);
			outcome = await deps.runAgent({ prompt });
			spent.costUsd += outcome.metrics.costUsd;
			spent.durationMs += outcome.metrics.durationMs;
			if (outcome.ok) break;
			log(`attempt ${attempt} failed: ${outcome.error}`);
		}

		if (!outcome.ok) return await abort(outcome.error);

		const existing = await github.listThreads();
		const { toPost } = dedupe(outcome.findings, existing);

		const comments: InlineCommentInput[] = [];
		const posted: KeyedFinding[] = [];
		for (const finding of toPost) {
			// 差分に無いファイルは投稿先が無い。プロンプトで禁止している（Task 10）が、
			// それでも出てきた場合は破棄してログに残す。
			if (!analysis.commentableLines.has(finding.file)) {
				log(`dropped a finding outside the diff: ${finding.file}`);
				continue;
			}
			// 行が差分内に無ければファイル単位コメントに落とす。スレッドは立つので
			// サマリーの索引には載る。
			const line = isCommentable(analysis, finding.file, finding.line ?? -1)
				? finding.line
				: null;
			comments.push({
				path: finding.file,
				line,
				body: renderInlineComment(finding, config.language),
			});
			posted.push(finding);
		}

		const event = decideEvent({
			newFindings: posted,
			existing,
			threshold: config.requestChangesOn,
			canSubmitVerdict: !pr.authorLogin.endsWith(BOT_AUTHOR_SUFFIX),
			approve: config.approve,
		});

		if (event !== 'NONE') {
			await github.createReview({
				body: messages(config.language).reviewPointer,
				event,
				commitId: pr.headSha,
				comments,
			});
		}

		// 投稿後に取り直す。サマリーを常に GitHub の現状から組み立てるため。
		const threads = event === 'NONE' ? existing : await github.listThreads();
		const runs = record(event, posted.length);

		await writeSticky({
			reviewedSha: pr.headSha,
			runs,
			board: buildBoard(threads),
			latest: latestRun(),
			failure: null,
		});

		const counts = emptyCounts();
		for (const finding of posted) counts[finding.severity] += 1;

		log(`posted ${comments.length} comment(s), event=${event}`);

		return {
			status: 'success',
			event,
			counts,
			findingsCount: posted.length,
			incompleteFiles: oversizedFiles.length,
			costUsd: spent.costUsd,
			totalCostUsd: totalCostUsd(runs),
			error: null,
		};
	} catch (error) {
		// ここを抜けた例外は main() を落とすだけで sticky に何も残らない。
		// 失敗経路に合流させ、バナーと FAILED の run マーカーを残す。
		return await abort(describe(error));
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
```

**インデントについて。** 上の `try { ... } catch` の中身は読みやすさのため 1 段浅く書いてある。実装時は `try` ブロックの中を 1 段深くし、`bun run fmt` で整えること。

**import に追加が必要なもの。** `Board`（`./core/board`）、`messages`（`./core/i18n`）。`LatestRun` は `./core/i18n` から。

**注意:** `createReview` の `body` を空文字にすると GitHub が 422 を返す可能性がある。`event: 'COMMENT'` は body 必須。実装時に実 API で確認できないため、**安全側として 1 行のポインタを入れる**。

```ts
await github.createReview({
	body: messages(config.language).reviewPointer,
	event,
	commitId: pr.headSha,
	comments,
});
```

`i18n.ts` の `Messages` に足す。

```ts
reviewPointer: string;
```

```ts
	// EN
	reviewPointer: 'See the review summary comment for the full status of this pull request.',
	// JA
	reviewPointer: 'この PR の全体状況はレビューサマリーコメントを参照してください。',
```

- [ ] **Step 4: 使われなくなった旧コードを消す**

`orchestrate.ts` がもう参照していないものを、まとめて削除する。

1. `src/core/marker.ts` から `SUMMARY_MARKER` / `FAILURE_MARKER` / `hasSummaryMarker` / `hasFailureMarker`
2. `tests/core/marker.test.ts` から `describe('summary marker')` / `describe('failure marker')`
3. `src/core/render.ts` から `renderSummary` / `renderFailureSummary` / `SummaryInput` と、それらだけが使っていたヘルパ（`renderCounts` / `sortBySeverity`）
4. `src/core/i18n.ts` の `Messages` から旧キー 10 個 — `summaryHeading` / `noFindings` / `findingsCount` / `incrementalNote` / `fullNote` / `unlocatableHeading` / `unlocatableNote` / `failureHeading` / `failureBody` / `instructionSource` — と `EN` / `JA` の対応する値。`oversizedWarning` と `errorDetails` は新しい描画でも使うので**残す**

Run:

```bash
grep -rn "SUMMARY_MARKER\|FAILURE_MARKER\|hasSummaryMarker\|hasFailureMarker\|renderSummary\|renderFailureSummary\|SummaryInput\|instructionSource" src tests
```

Expected: 出力なし

- [ ] **Step 5: テストが通ることを確認**

Run: `bun test tests/orchestrate.test.ts`
Expected: PASS

- [ ] **Step 6: 型・lint・全テスト**

Run: `bun run typecheck && bun run lint && bun test`
Expected: 全て PASS（skip ゼロ件）

- [ ] **Step 7: コミット**

```bash
git add src tests
git commit -m "feat(orchestrate): sticky を状態の持ち主にしてフローを組み直す"
```

---

## Task 9: 失敗パスのテストを固める

**Files:**

- Test: `tests/orchestrate.test.ts`

Task 8 で失敗パスの実装は済んでいる。ここではその挙動をテストで固定する。実装に不足があればここで直す。

**Interfaces:**

- Consumes: Task 8 の `runReview`

- [ ] **Step 1: 失敗するテストを書く**

```ts
test('リトライを使い切ったら sticky に失敗バナーを出す', async () => {
	const boom = {
		ok: false as const,
		error: 'agent timed out',
		metrics: { costUsd: 0.04, durationMs: 1000 },
	};
	const { deps, reviews, stickyWrites } = setup({
		outcomes: [boom, boom, boom],
	});
	const result = await runReview(deps, CONFIG);
	expect(result.status).toBe('failed');
	expect(reviews).toHaveLength(0);
	expect(stickyWrites).toHaveLength(1);
	expect(stickyWrites[0]!.body).toContain('agent timed out');
	expect(stickyWrites[0]!.body).toContain('自動レビューを完了できませんでした');
});

test('失敗時に reviewed を進めない', async () => {
	const boom = {
		ok: false as const,
		error: 'boom',
		metrics: { costUsd: 0, durationMs: 0 },
	};
	const { deps, stickyWrites } = setup({
		lastReviewed: 'prev',
		outcomes: [boom, boom, boom],
	});
	await runReview(deps, CONFIG);
	expect(stickyWrites[0]!.body).toContain(
		'<!-- review-bot:v1 sticky reviewed=prev -->',
	);
});

test('sticky が無い状態で失敗したら base に据え置く', async () => {
	const boom = {
		ok: false as const,
		error: 'boom',
		metrics: { costUsd: 0, durationMs: 0 },
	};
	const { deps, stickyWrites } = setup({ outcomes: [boom, boom, boom] });
	await runReview(deps, CONFIG);
	expect(stickyWrites[0]!.body).toContain(
		'<!-- review-bot:v1 sticky reviewed=base -->',
	);
});

test('失敗時に FAILED の run マーカーを追記しコストを乗せる', async () => {
	const boom = {
		ok: false as const,
		error: 'boom',
		metrics: { costUsd: 0.04, durationMs: 1000 },
	};
	const { deps, stickyWrites } = setup({ outcomes: [boom, boom, boom] });
	const result = await runReview(deps, CONFIG);
	const runs = parseRunMarkers(stickyWrites[0]!.body);
	expect(runs).toHaveLength(1);
	expect(runs[0]!.event).toBe('FAILED');
	expect(runs[0]!.attempts).toBe(3);
	expect(result.costUsd).toBeCloseTo(0.12, 4);
	expect(result.totalCostUsd).toBeCloseTo(0.12, 4);
});

test('失敗時に自分の APPROVE を取り下げる', async () => {
	const boom = {
		ok: false as const,
		error: 'boom',
		metrics: { costUsd: 0, durationMs: 0 },
	};
	const { deps, dismissals } = setup({ outcomes: [boom, boom, boom] });
	await runReview(deps, CONFIG);
	expect(dismissals).toHaveLength(1);
});

test('成功時は APPROVE を取り下げない', async () => {
	const { deps, dismissals } = setup();
	await runReview(deps, CONFIG);
	expect(dismissals).toHaveLength(0);
});

test('fork PR では sticky も書かない', async () => {
	const { deps, stickyWrites, reviews } = setup({ pr: { isFork: true } });
	const result = await runReview(deps, CONFIG);
	expect(result.status).toBe('failed');
	expect(stickyWrites).toHaveLength(0);
	expect(reviews).toHaveLength(0);
});
```

- [ ] **Step 2: テストを走らせる**

Run: `bun test tests/orchestrate.test.ts`
Expected: PASS。落ちたら Task 8 の実装を直す（テストが正、実装が従）。

- [ ] **Step 3: 型・lint・全テスト**

Run: `bun run typecheck && bun run lint && bun test`
Expected: 全て PASS

- [ ] **Step 4: コミット**

```bash
git add tests/orchestrate.test.ts src
git commit -m "test(orchestrate): 失敗パスの挙動を固定する"
```

---

## Task 10: プロンプトで差分外の指摘を禁止する

**Files:**

- Modify: `src/core/prompt.ts`
- Test: `tests/core/prompt.test.ts`

**Interfaces:**

- Consumes: `buildPrompt`（既存）

行を特定できない指摘はファイル単位コメントに落ちるが、**差分に含まれないファイル**への指摘は投稿先が無い。プロンプトで防ぐ。

- [ ] **Step 1: 失敗するテストを書く**

`tests/core/prompt.test.ts` に追記する。

```ts
test('差分外のファイルを指摘対象にしないよう指示する', () => {
	const prompt = buildPrompt(baseInput());
	expect(prompt).toContain('差分に含まれるファイル以外を指摘対象にしない');
});
```

`baseInput()` は既存テストが使っているヘルパ。無ければ既存テストの入力リテラルに合わせる。

- [ ] **Step 2: テストが落ちることを確認**

Run: `bun test tests/core/prompt.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

`src/core/prompt.ts` の `## 出力` セクション、`'line にはツールの説明どおり…'` の行の直後に足す。

```ts
		'差分に含まれるファイル以外を指摘対象にしないでください。差分外のファイルに対する指摘は投稿先が無いため破棄されます。',
```

- [ ] **Step 4: テストが通ることを確認**

Run: `bun test tests/core/prompt.test.ts`
Expected: PASS

破棄側の実装とテストは Task 8 で入っている（`analysis.commentableLines.has(finding.file)` で弾き、`posted` にだけ積む）。このタスクはモデル側の入口を塞ぐだけ。

- [ ] **Step 5: 型・lint・全テスト**

Run: `bun run typecheck && bun run lint && bun test`
Expected: 全て PASS

- [ ] **Step 6: コミット**

```bash
git add src/core/prompt.ts tests/core/prompt.test.ts
git commit -m "feat(prompt): 差分外のファイルへの指摘を禁止する"
```

---

## Task 11: README の更新とビルド確認

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Inputs 表に `approve` を足す**

`request-changes-on` の行の直後に足す。

```markdown
| `approve` | `false` | Submit as `APPROVE` when the pull request has no outstanding findings. See the warning below. |
```

- [ ] **Step 2: Outputs 表を更新する**

`review-event` の説明を `COMMENT`, `REQUEST_CHANGES`, `APPROVE`, or `NONE` に変える。末尾に 2 行足す。

```markdown
| `cost-usd` | Cost of this run in USD, summed across retries |
| `total-cost-usd` | Cumulative cost of every review run on this pull request |
```

- [ ] **Step 3: `max-cost-usd` の説明を補足する**

```markdown
| `max-cost-usd` | `5` | Budget ceiling for **a single agent run**. With `max-retries: 3` a single job can spend up to three times this. The cumulative spend is shown in the summary comment. |
```

- [ ] **Step 4: 冒頭の説明を書き直す**

現在の 3〜8 行目を次に差し替える。

```markdown
Review pull requests with Claude. Findings are posted as inline review comments, and a single **summary comment** is kept up to date with the current state of the pull request.

- Findings are posted where they belong, so each one can be discussed in its own thread.
- One summary comment per pull request, edited in place. It indexes every outstanding finding, records the review history, and shows the cumulative cost.
- The state lives on GitHub: the findings are the review threads themselves, and the incremental starting point and the run history are markers inside the summary comment. There is no database.
- Reviews are incremental by default: after the first run only the changes since the last review are sent to the model.
- A review is only submitted when there is something to submit. A push that produces no new findings just refreshes the summary comment.
```

- [ ] **Step 5: APPROVE の警告節を足す**

`## \`request-changes-on\` and branch protection` 節の直後に足す。

```markdown
## `approve` is not a review

`approve` is off by default. Turn it on and the action submits `APPROVE` when the pull request has no outstanding findings — that is, when every finding it raised has been resolved.

**A bot approval must not be relied on as a branch-protection gate.** Whether a finding counts as outstanding is decided by the resolve button, and the pull request author can press it themselves. If your branch protection requires N approvals and this action's approval satisfies one of them, an author can self-approve by resolving their own threads.

Treating a resolved thread as "handled" is deliberate and matches GitHub's own "Require conversation resolution before merging". It is a convenience signal, not a review.

If the review fails after an approval was submitted, the action dismisses its own approval so the pull request does not stay green on a review that never ran.
```

- [ ] **Step 6: Incremental reviews 節を更新する**

`The action finds its own last review by a marker embedded in the review body, and diffs from that commit to the pull request head.` を次に差し替える。

```markdown
The action finds its own summary comment, reads the `reviewed=<sha>` marker inside it, and diffs from that commit to the pull request head. The first run diffs from the base commit. Only a comment authored by the same identity as the token is trusted as the summary comment.
```

- [ ] **Step 7: Fail-closed behaviour 節を更新する**

`The failure is also posted as a review comment, and that comment is marked so it never becomes the starting point of the next incremental review.` を次に差し替える。

```markdown
The failure is shown as a banner at the top of the summary comment, and `reviewed=<sha>` is left where it was, so the range that failed is reviewed again on the next run. If the action had previously approved the pull request, that approval is dismissed.
```

- [ ] **Step 8: Not supported 節を更新する**

`- Replying to review threads / conversational follow-ups.` は残す。`- A repository configuration file...` は残す。`suggestion` の行も残す。変更なしでよいことを確認する。

- [ ] **Step 9: ビルドと全チェック**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: 全て PASS

- [ ] **Step 10: フォーマット**

Run: `bun run fmt && git diff --stat`
Expected: 差分があれば取り込む

- [ ] **Step 11: コミット**

```bash
git add README.md dist
git commit -m "docs: sticky サマリーと approve の挙動を README に反映"
```

---

## Self-Review 結果

**1. Spec coverage**

| spec の節              | 実装タスク                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| 1. アーキテクチャ転換  | Task 1（マーカー追加）/ Task 8（旧マーカー削除）                                          |
| 2. sticky サマリーの形 | Task 4                                                                                    |
| 3. マーカー定義        | Task 1                                                                                    |
| 4. モジュール構成      | Task 1〜8                                                                                 |
| 5. データフロー        | Task 8                                                                                    |
| 6. APPROVE の設計      | Task 3（判定）/ Task 7（input）/ Task 8, 9（提出と dismiss）                              |
| 7. resolve と outdated | Task 2（board）/ Task 3（判定）/ Task 4（表示）                                           |
| 8. エラー処理          | Task 8（sticky 失敗・エージェント失敗）/ Task 9（テスト）/ Task 10（差分外破棄）          |
| 9. テスト計画          | 各タスクの Step 1                                                                         |
| 10. README             | Task 11                                                                                   |
| 11. 移行               | 互換シムを作らないので実装不要。Task 11 の README で言及なし（v2 タグはリリース時の作業） |
| 12. バックログ         | 実装しない                                                                                |

**2. 未確定事項（実装中に潰す）**

- `pulls.createReview` の `comments[]` が `subject_type` を受け付けるか → Task 6 Step 1 で確定。両方の実装を用意済み。
- `createReview` の `body` を空にできるか → 空にせず 1 行のポインタを入れる（Task 8 Step 3）。

**3. spec からの変更点（2 件、いずれも計画内で明記）**

- `decideEvent` の `canRequestChanges` → `canSubmitVerdict` に改名し、APPROVE にも適用（Task 3）
- sticky コメントの作成者同一性チェックを追加（Task 6）。他人が sticky を騙って `reviewed` を head まで進め、レビューをスキップさせる経路を塞ぐ
