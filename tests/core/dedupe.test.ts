import { describe, expect, test } from 'bun:test';
import { dedupe, type ExistingFinding } from '../../src/core/dedupe';
import { findingKey } from '../../src/core/marker';
import type { Finding } from '../../src/core/schema';

function finding(overrides: Partial<Finding> = {}): Finding {
	return {
		severity: 'major',
		file: 'src/a.ts',
		line: 10,
		title: 'null 参照の可能性',
		body: '説明',
		...overrides,
	};
}

function existing(
	f: Finding,
	overrides: Partial<ExistingFinding> = {},
): ExistingFinding {
	return {
		key: findingKey(f.file, f.title),
		severity: f.severity,
		isResolved: false,
		isOutdated: false,
		...overrides,
	};
}

describe('dedupe', () => {
	test('既存コメントが無ければ全件を投稿対象にする', () => {
		const result = dedupe([finding()], []);
		expect(result.toPost).toHaveLength(1);
		expect(result.alreadyPosted).toHaveLength(0);
		expect(result.toPost[0]!.key).toMatch(/^[0-9a-f]{12}$/);
	});

	test('既存と一致する指摘は投稿しない', () => {
		const f = finding();
		const result = dedupe([f], [existing(f)]);
		expect(result.toPost).toHaveLength(0);
		expect(result.alreadyPosted).toHaveLength(1);
	});

	test('resolve 済みでも再投稿しない', () => {
		const f = finding();
		const result = dedupe([f], [existing(f, { isResolved: true })]);
		expect(result.toPost).toHaveLength(0);
	});

	test('outdated でも再投稿しない', () => {
		const f = finding();
		const result = dedupe([f], [existing(f, { isOutdated: true })]);
		expect(result.toPost).toHaveLength(0);
	});

	test('行が変わっても同じ指摘なら再投稿しない', () => {
		const f = finding({ line: 10 });
		const moved = finding({ line: 250 });
		const result = dedupe([moved], [existing(f)]);
		expect(result.toPost).toHaveLength(0);
	});

	test('同一レビュー内の重複を 1 件に畳む', () => {
		const f = finding();
		const result = dedupe([f, { ...f, body: '別の説明' }], []);
		expect(result.toPost).toHaveLength(1);
	});

	test('別ファイルの同名指摘は別物として扱う', () => {
		const a = finding({ file: 'src/a.ts' });
		const b = finding({ file: 'src/b.ts' });
		const result = dedupe([a, b], []);
		expect(result.toPost).toHaveLength(2);
	});
});
