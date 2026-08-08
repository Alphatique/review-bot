import { describe, expect, test } from 'bun:test';
import { isAtLeastAsSevere, parseFindings } from '../../src/core/schema';

describe('parseFindings', () => {
	test('妥当なペイロードを受け入れる', () => {
		const result = parseFindings({
			findings: [
				{
					severity: 'major',
					file: 'src/a.ts',
					line: 12,
					title: 'null 参照の可能性',
					body: 'foo が undefined になりうる',
				},
			],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toHaveLength(1);
		expect(result.value[0]!.severity).toBe('major');
	});

	test('空配列を受け入れる', () => {
		const result = parseFindings({ findings: [] });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toHaveLength(0);
	});

	test('line: null を受け入れる', () => {
		const result = parseFindings({
			findings: [
				{ severity: 'minor', file: 'a.ts', line: null, title: 't', body: 'b' },
			],
		});
		expect(result.ok).toBe(true);
	});

	test('未知の severity を拒否する', () => {
		const result = parseFindings({
			findings: [
				{ severity: 'P0', file: 'a.ts', line: 1, title: 't', body: 'b' },
			],
		});
		expect(result.ok).toBe(false);
	});

	test('空文字の title を拒否する', () => {
		const result = parseFindings({
			findings: [
				{ severity: 'minor', file: 'a.ts', line: 1, title: '', body: 'b' },
			],
		});
		expect(result.ok).toBe(false);
	});

	test('line が 0 以下なら拒否する', () => {
		const result = parseFindings({
			findings: [
				{ severity: 'minor', file: 'a.ts', line: 0, title: 't', body: 'b' },
			],
		});
		expect(result.ok).toBe(false);
	});

	test('findings キーが無ければ拒否する', () => {
		expect(parseFindings({}).ok).toBe(false);
	});
});

describe('isAtLeastAsSevere', () => {
	test('同じ重大度なら true', () => {
		expect(isAtLeastAsSevere('major', 'major')).toBe(true);
	});

	test('より重ければ true', () => {
		expect(isAtLeastAsSevere('critical', 'major')).toBe(true);
	});

	test('より軽ければ false', () => {
		expect(isAtLeastAsSevere('minor', 'major')).toBe(false);
	});
});
