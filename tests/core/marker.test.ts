import { describe, expect, test } from 'bun:test';
import {
	buildInlineMarker,
	findingKey,
	hasReviewMarker,
	parseInlineMarker,
	parseInlineTitle,
	REVIEW_MARKER,
} from '../../src/core/marker';

describe('findingKey', () => {
	test('同じ入力なら同じキーを返す', () => {
		expect(findingKey('a.ts', 'null 参照')).toBe(
			findingKey('a.ts', 'null 参照'),
		);
	});

	test('12 桁の hex を返す', () => {
		expect(findingKey('a.ts', 'x')).toMatch(/^[0-9a-f]{12}$/);
	});

	test('ファイルが違えば別のキーになる', () => {
		expect(findingKey('a.ts', 'x')).not.toBe(findingKey('b.ts', 'x'));
	});

	test('title の大文字小文字と余分な空白を無視する', () => {
		expect(findingKey('a.ts', '  Null  参照 ')).toBe(
			findingKey('a.ts', 'null 参照'),
		);
	});

	test('title の末尾句読点を無視する', () => {
		expect(findingKey('a.ts', 'null 参照。')).toBe(
			findingKey('a.ts', 'null 参照'),
		);
	});
});

describe('inline marker', () => {
	test('埋め込んだマーカーを取り出せる', () => {
		const marker = buildInlineMarker('abc123def456', 'major');
		const parsed = parseInlineMarker(`本文\n\n${marker}`);
		expect(parsed).toEqual({ key: 'abc123def456', severity: 'major' });
	});

	test('マーカーが無ければ null', () => {
		expect(parseInlineMarker('ただの本文')).toBeNull();
	});

	test('不正な severity なら null', () => {
		expect(
			parseInlineMarker('<!-- review-bot:v1 key=abc123def456 sev=P0 -->'),
		).toBeNull();
	});

	test('本文中に偽マーカーがあっても最後の一致を採る', () => {
		const fake = '<!-- review-bot:v1 key=000000000000 sev=minor -->';
		const real = buildInlineMarker('abc123def456', 'critical');
		const parsed = parseInlineMarker(`${fake}\n本文\n${real}`);
		expect(parsed).toEqual({ key: 'abc123def456', severity: 'critical' });
	});
});

describe('review marker', () => {
	test('レビューマーカーを検出できる', () => {
		expect(hasReviewMarker(`サマリ\n${REVIEW_MARKER}`)).toBe(true);
	});

	test('無ければ false', () => {
		expect(hasReviewMarker('ただの本文')).toBe(false);
	});

	test('マーカー文字列は v1 と同じままにする', () => {
		expect(REVIEW_MARKER).toBe('<!-- review-bot:v1 summary -->');
	});
});

describe('parseInlineTitle', () => {
	test('1 行目からタイトルを取り出す', () => {
		const body = '🔴 **critical** — トークンがログに出る\n\n本文';
		expect(parseInlineTitle(body)).toBe('トークンがログに出る');
	});

	test('severity が違っても読める', () => {
		expect(parseInlineTitle('🟡 **minor** — 些細な問題\n\n本文')).toBe(
			'些細な問題',
		);
	});

	test('書式が違えば null', () => {
		expect(parseInlineTitle('ただの本文')).toBeNull();
	});

	test('空文字なら null', () => {
		expect(parseInlineTitle('')).toBeNull();
	});

	test('renderInlineComment の出力を読み戻せる', () => {
		const body = '🟠 **major** — `foo` が undefined になりうる\n\n説明';
		expect(parseInlineTitle(body)).toBe('`foo` が undefined になりうる');
	});
});
