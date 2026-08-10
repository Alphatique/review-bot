import { describe, expect, test } from 'bun:test';
import { decideEvent } from '../../src/core/decision';
import type { Severity } from '../../src/core/schema';
import type { ThreadInfo } from '../../src/core/thread';

function existing(severity: Severity, isResolved = false): ThreadInfo {
	return {
		id: 'PRRT_1',
		commentId: 1,
		key: 'x'.repeat(12),
		severity,
		file: 'src/a.ts',
		line: 1,
		title: 'なにか',
		isResolved,
		isOutdated: false,
	};
}

describe('decideEvent', () => {
	test('threshold が none なら常に COMMENT', () => {
		expect(
			decideEvent({
				newFindings: [{ severity: 'critical' }],
				existing: [],
				threshold: 'none',
				canRequestChanges: true,
			}),
		).toBe('COMMENT');
	});

	test('閾値以上の新規指摘があれば REQUEST_CHANGES', () => {
		expect(
			decideEvent({
				newFindings: [{ severity: 'critical' }],
				existing: [],
				threshold: 'critical',
				canRequestChanges: true,
			}),
		).toBe('REQUEST_CHANGES');
	});

	test('閾値未満の指摘だけなら COMMENT', () => {
		expect(
			decideEvent({
				newFindings: [{ severity: 'minor' }],
				existing: [],
				threshold: 'major',
				canRequestChanges: true,
			}),
		).toBe('COMMENT');
	});

	test('未解決の既存指摘が閾値以上なら REQUEST_CHANGES を維持する', () => {
		expect(
			decideEvent({
				newFindings: [],
				existing: [existing('major')],
				threshold: 'major',
				canRequestChanges: true,
			}),
		).toBe('REQUEST_CHANGES');
	});

	test('既存指摘が resolve 済みなら数えない', () => {
		expect(
			decideEvent({
				newFindings: [],
				existing: [existing('critical', true)],
				threshold: 'critical',
				canRequestChanges: true,
			}),
		).toBe('COMMENT');
	});

	test('canRequestChanges が false なら必ず COMMENT', () => {
		expect(
			decideEvent({
				newFindings: [{ severity: 'critical' }],
				existing: [],
				threshold: 'critical',
				canRequestChanges: false,
			}),
		).toBe('COMMENT');
	});

	test('指摘が無ければ COMMENT', () => {
		expect(
			decideEvent({
				newFindings: [],
				existing: [],
				threshold: 'minor',
				canRequestChanges: true,
			}),
		).toBe('COMMENT');
	});
});
