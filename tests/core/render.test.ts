import { describe, expect, test } from 'bun:test';
import type { KeyedFinding } from '../../src/core/dedupe';
import {
	FAILURE_MARKER,
	parseInlineMarker,
	SUMMARY_MARKER,
} from '../../src/core/marker';
import {
	renderFailureSummary,
	renderInlineComment,
	renderSummary,
} from '../../src/core/render';

const FINDING: KeyedFinding = {
	key: 'abc123def456',
	severity: 'major',
	file: 'src/a.ts',
	line: 10,
	title: 'null 参照の可能性',
	body: 'foo が undefined になりうる',
};

describe('renderInlineComment', () => {
	test('重大度・タイトル・本文を含む', () => {
		const out = renderInlineComment(FINDING, 'ja');
		expect(out).toContain('major');
		expect(out).toContain('null 参照の可能性');
		expect(out).toContain('foo が undefined になりうる');
	});

	test('末尾にマーカーを埋め込む', () => {
		const out = renderInlineComment(FINDING, 'ja');
		expect(parseInlineMarker(out)).toEqual({
			key: 'abc123def456',
			severity: 'major',
		});
	});

	test('英語でも描画できる', () => {
		expect(renderInlineComment(FINDING, 'en')).toContain('major');
	});
});

describe('renderSummary', () => {
	test('サマリマーカーを含む', () => {
		const out = renderSummary({
			lang: 'ja',
			posted: [FINDING],
			unlocatable: [],
			excludedFiles: [],
			oversizedFiles: [],
			mode: 'auto',
		});
		expect(out).toContain(SUMMARY_MARKER);
	});

	test('重大度ごとの件数を出す', () => {
		const out = renderSummary({
			lang: 'ja',
			posted: [FINDING, { ...FINDING, key: 'f'.repeat(12), severity: 'minor' }],
			unlocatable: [],
			excludedFiles: [],
			oversizedFiles: [],
			mode: 'auto',
		});
		expect(out).toContain('major');
		expect(out).toContain('minor');
	});

	test('指摘が無いときも成立する', () => {
		const out = renderSummary({
			lang: 'ja',
			posted: [],
			unlocatable: [],
			excludedFiles: [],
			oversizedFiles: [],
			mode: 'auto',
		});
		expect(out).toContain(SUMMARY_MARKER);
		expect(out.length).toBeGreaterThan(0);
	});

	test('行を特定できなかった指摘をサマリ本体に列挙する', () => {
		const out = renderSummary({
			lang: 'ja',
			posted: [],
			unlocatable: [{ ...FINDING, line: null }],
			excludedFiles: [],
			oversizedFiles: [],
			mode: 'auto',
		});
		expect(out).toContain('null 参照の可能性');
		expect(out).toContain('src/a.ts');
	});

	test('サイズ超過ファイルがあれば警告を出す', () => {
		const out = renderSummary({
			lang: 'ja',
			posted: [],
			unlocatable: [],
			excludedFiles: [],
			oversizedFiles: ['src/huge.ts'],
			mode: 'auto',
		});
		expect(out).toContain('src/huge.ts');
	});
});

describe('renderFailureSummary', () => {
	test('エラー本文とマーカーを含む', () => {
		const out = renderFailureSummary('timed out', 'ja');
		expect(out).toContain('timed out');
		expect(out).toContain(SUMMARY_MARKER);
	});

	test('失敗マーカーを含み、増分の起点にならないようにする', () => {
		expect(renderFailureSummary('timed out', 'ja')).toContain(FAILURE_MARKER);
	});

	test('成功サマリには失敗マーカーを含めない', () => {
		const out = renderSummary({
			lang: 'ja',
			posted: [],
			unlocatable: [],
			excludedFiles: [],
			oversizedFiles: [],
			mode: 'auto',
		});
		expect(out).not.toContain(FAILURE_MARKER);
	});

	test('エラー本文が空でも成立する', () => {
		expect(renderFailureSummary('', 'en')).toContain(SUMMARY_MARKER);
	});
});
