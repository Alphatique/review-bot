import { describe, expect, test } from 'bun:test';
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

describe('summary marker', () => {
	test('サマリマーカーを検出できる', () => {
		expect(hasSummaryMarker(`サマリ\n${SUMMARY_MARKER}`)).toBe(true);
	});

	test('無ければ false', () => {
		expect(hasSummaryMarker('ただの本文')).toBe(false);
	});
});

describe('failure marker', () => {
	test('失敗マーカーを検出できる', () => {
		expect(hasFailureMarker(`失敗\n${FAILURE_MARKER}`)).toBe(true);
	});

	test('成功サマリには含まれない', () => {
		expect(hasFailureMarker(`サマリ\n${SUMMARY_MARKER}`)).toBe(false);
	});
});

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
