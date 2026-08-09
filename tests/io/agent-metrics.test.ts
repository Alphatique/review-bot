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
