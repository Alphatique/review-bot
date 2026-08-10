import { describe, expect, test } from 'bun:test';
import { planResolutions } from '../../src/core/resolution';
import type { ThreadInfo } from '../../src/core/thread';

function thread(overrides: Partial<ThreadInfo> = {}): ThreadInfo {
	return {
		id: 'PRRT_1',
		commentId: 1,
		key: 'a'.repeat(12),
		severity: 'major',
		file: 'src/a.ts',
		line: 12,
		title: 'null 参照の可能性',
		isResolved: false,
		isOutdated: false,
		...overrides,
	};
}

describe('planResolutions', () => {
	test('未解決スレッドに一致する key を resolve 対象にする', () => {
		const t = thread();
		const plan = planResolutions({
			threads: [t],
			resolved: [{ key: t.key, reason: '削除された' }],
		});
		expect(plan.toResolve).toEqual([{ thread: t, reason: '削除された' }]);
		expect(plan.ignored).toEqual([]);
	});

	test('既に解決済みの key は無視する', () => {
		const t = thread({ isResolved: true });
		const plan = planResolutions({
			threads: [t],
			resolved: [{ key: t.key, reason: 'r' }],
		});
		expect(plan.toResolve).toEqual([]);
		expect(plan.ignored).toEqual([t.key]);
	});

	test('存在しない key は無視する', () => {
		const plan = planResolutions({
			threads: [thread()],
			resolved: [{ key: 'b'.repeat(12), reason: 'r' }],
		});
		expect(plan.toResolve).toEqual([]);
		expect(plan.ignored).toEqual(['b'.repeat(12)]);
	});

	test('重複した key を畳む', () => {
		const t = thread();
		const plan = planResolutions({
			threads: [t],
			resolved: [
				{ key: t.key, reason: '1 回目' },
				{ key: t.key, reason: '2 回目' },
			],
		});
		expect(plan.toResolve).toHaveLength(1);
		expect(plan.toResolve[0]!.reason).toBe('1 回目');
	});

	test('resolved が空なら何もしない', () => {
		const plan = planResolutions({ threads: [thread()], resolved: [] });
		expect(plan.toResolve).toEqual([]);
		expect(plan.ignored).toEqual([]);
	});

	test('outdated でも未解決なら対象になる', () => {
		const t = thread({ isOutdated: true });
		const plan = planResolutions({
			threads: [t],
			resolved: [{ key: t.key, reason: 'r' }],
		});
		expect(plan.toResolve).toHaveLength(1);
	});
});
