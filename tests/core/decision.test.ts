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
			decideEvent(input({ approve: true, existing: [existing('major', true)] })),
		).toBe('APPROVE');
	});

	test('approve が on でも未解決があれば APPROVE しない', () => {
		expect(
			decideEvent(
				input({ approve: true, existing: [existing('minor', false)] }),
			),
		).toBe('COMMENT');
	});

	test('approve が on でも今回の新規指摘があれば APPROVE しない', () => {
		expect(
			decideEvent(input({ approve: true, newFindings: [severity('minor')] })),
		).toBe('COMMENT');
	});

	test('bot 自身の PR には APPROVE も出さない', () => {
		expect(
			decideEvent(input({ approve: true, canSubmitVerdict: false })),
		).toBe('NONE');
	});

	test('outdated かどうかは判定に影響しない', () => {
		expect(
			decideEvent(input({ existing: [existing('critical', false)] })),
		).toBe('REQUEST_CHANGES');
	});
});
