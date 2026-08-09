import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config';

const VALID = {
	'claude-code-oauth-token': 'tok',
	'github-token': 'ghs_x',
	repo: 'owner/repo',
	'pr-number': '42',
	mode: 'auto',
	language: 'ja',
	'request-changes-on': 'major',
	'fail-on-error': 'true',
	'fail-on-incomplete': 'false',
	model: 'claude-sonnet-5',
	effort: 'high',
	'max-retries': '3',
	'timeout-minutes': '8',
	'max-cost-usd': '5',
	'diff-max-bytes': '500000',
	exclude: 'packages/foo/**\npackages/bar/**',
};

describe('loadConfig', () => {
	test('妥当な入力を受け入れる', () => {
		const result = loadConfig(VALID);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.prNumber).toBe(42);
		expect(result.value.language).toBe('ja');
		expect(result.value.repo).toBe('owner/repo');
		expect(result.value.auth).toEqual({ kind: 'oauth', value: 'tok' });
	});

	test('exclude を改行で分割し既定に追加する', () => {
		const result = loadConfig(VALID);
		if (!result.ok) throw new Error('expected ok');
		expect(result.value.exclude).toContain('packages/foo/**');
		expect(result.value.exclude).toContain('packages/bar/**');
		expect(result.value.exclude).toContain('**/bun.lock');
	});

	test('API キーでも認証できる', () => {
		const result = loadConfig({
			...VALID,
			'claude-code-oauth-token': '',
			'anthropic-api-key': 'sk-x',
		});
		if (!result.ok) throw new Error('expected ok');
		expect(result.value.auth).toEqual({ kind: 'apiKey', value: 'sk-x' });
	});

	test('認証情報が両方無ければ失敗する', () => {
		const result = loadConfig({ ...VALID, 'claude-code-oauth-token': '' });
		expect(result.ok).toBe(false);
	});

	test('github-token が無ければ失敗する', () => {
		const result = loadConfig({ ...VALID, 'github-token': '' });
		expect(result.ok).toBe(false);
	});

	test('repo が空なら失敗する', () => {
		expect(loadConfig({ ...VALID, repo: '' }).ok).toBe(false);
	});

	test('pr-number が数値でなければ失敗する', () => {
		expect(loadConfig({ ...VALID, 'pr-number': 'abc' }).ok).toBe(false);
	});

	test('未知の language を拒否する', () => {
		expect(loadConfig({ ...VALID, language: 'fr' }).ok).toBe(false);
	});

	test('未知の mode を拒否する', () => {
		expect(loadConfig({ ...VALID, mode: 'turbo' }).ok).toBe(false);
	});

	test('未知の request-changes-on を拒否する', () => {
		expect(loadConfig({ ...VALID, 'request-changes-on': 'P0' }).ok).toBe(false);
	});

	test('未知の effort を拒否する', () => {
		expect(loadConfig({ ...VALID, effort: 'turbo' }).ok).toBe(false);
	});

	test('max-retries が 0 以下なら失敗する', () => {
		expect(loadConfig({ ...VALID, 'max-retries': '0' }).ok).toBe(false);
	});

	test('timeout をミリ秒に変換する', () => {
		const result = loadConfig({ ...VALID, 'timeout-minutes': '2' });
		if (!result.ok) throw new Error('expected ok');
		expect(result.value.timeoutMs).toBe(120_000);
	});

	test('真偽値のパースが効く', () => {
		const result = loadConfig({ ...VALID, 'fail-on-incomplete': 'true' });
		if (!result.ok) throw new Error('expected ok');
		expect(result.value.failOnIncomplete).toBe(true);
	});
});

describe('approve', () => {
	test('既定は false', () => {
		const result = loadConfig(VALID);
		expect(result.ok && result.value.approve).toBe(false);
	});

	test('true を指定すると有効になる', () => {
		const result = loadConfig({ ...VALID, approve: 'true' });
		expect(result.ok && result.value.approve).toBe(true);
	});

	test('不正な値は false として扱う', () => {
		const result = loadConfig({ ...VALID, approve: 'maybe' });
		expect(result.ok && result.value.approve).toBe(false);
	});
});
