import { describe, expect, test } from 'bun:test';
import { decideEvent, type DecisionInput } from '../../src/core/decision';

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
	return {
		outstanding: [],
		blockOn: 'major',
		approve: true,
		hasUntrackedFindings: false,
		canSubmitVerdict: true,
		liveVerdict: null,
		hasSomethingToReport: false,
		...overrides,
	};
}

describe('decideEvent', () => {
	test('閾値以上の未解決があれば REQUEST_CHANGES', () => {
		expect(decideEvent(input({ outstanding: ['major'] }))).toBe(
			'REQUEST_CHANGES',
		);
	});

	test('閾値より重い未解決でも REQUEST_CHANGES', () => {
		expect(decideEvent(input({ outstanding: ['critical'] }))).toBe(
			'REQUEST_CHANGES',
		);
	});

	test('閾値未満だけなら APPROVE', () => {
		expect(decideEvent(input({ outstanding: ['minor'] }))).toBe('APPROVE');
	});

	test('未解決が無ければ APPROVE', () => {
		expect(decideEvent(input())).toBe('APPROVE');
	});

	test('block-on が none なら REQUEST_CHANGES を出さない', () => {
		expect(
			decideEvent(input({ blockOn: 'none', outstanding: ['critical'] })),
		).toBe('APPROVE');
	});

	test('approve が false なら承認せず、報告するものが無ければ NONE', () => {
		expect(decideEvent(input({ approve: false }))).toBe('NONE');
	});

	test('approve が false でも報告するものがあれば COMMENT', () => {
		expect(
			decideEvent(input({ approve: false, hasSomethingToReport: true })),
		).toBe('COMMENT');
	});

	test('追跡できない指摘があれば APPROVE しない', () => {
		expect(
			decideEvent(
				input({ hasUntrackedFindings: true, hasSomethingToReport: true }),
			),
		).toBe('COMMENT');
	});

	test('判定を提出できないなら REQUEST_CHANGES を COMMENT に落とす', () => {
		expect(
			decideEvent(
				input({
					outstanding: ['critical'],
					canSubmitVerdict: false,
					hasSomethingToReport: true,
				}),
			),
		).toBe('COMMENT');
	});

	test('判定を提出できないなら APPROVE も COMMENT に落とす', () => {
		expect(
			decideEvent(
				input({ canSubmitVerdict: false, hasSomethingToReport: true }),
			),
		).toBe('COMMENT');
	});

	test('生きている判定と同じなら出し直さない', () => {
		expect(
			decideEvent(
				input({
					outstanding: ['critical'],
					liveVerdict: { id: 1, state: 'CHANGES_REQUESTED' },
				}),
			),
		).toBe('NONE');
	});

	test('生きている判定と同じでも報告するものがあれば COMMENT で投稿する', () => {
		expect(
			decideEvent(
				input({
					outstanding: ['critical'],
					liveVerdict: { id: 1, state: 'CHANGES_REQUESTED' },
					hasSomethingToReport: true,
				}),
			),
		).toBe('COMMENT');
	});

	test('生きている判定と変わるなら出し直す', () => {
		expect(
			decideEvent(
				input({ liveVerdict: { id: 1, state: 'CHANGES_REQUESTED' } }),
			),
		).toBe('APPROVE');
	});

	test('報告するものも判定の変化も無ければ NONE', () => {
		expect(
			decideEvent(input({ liveVerdict: { id: 1, state: 'APPROVED' } })),
		).toBe('NONE');
	});
});
