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
