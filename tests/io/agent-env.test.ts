import { describe, expect, test } from 'bun:test';
import { buildAgentEnv } from '../../src/io/agent';

const SOURCE = {
	PATH: '/usr/bin',
	HOME: '/home/runner',
	TMPDIR: '/tmp',
	GITHUB_TOKEN: 'ghs_secret',
	GH_TOKEN: 'ghs_secret',
	'INPUT_GITHUB-TOKEN': 'ghs_secret',
	'INPUT_ANTHROPIC-API-KEY': 'sk-secret',
	ACTIONS_RUNTIME_TOKEN: 'runtime_secret',
	SOME_OTHER_VAR: 'x',
} as NodeJS.ProcessEnv;

describe('buildAgentEnv', () => {
	test('許可した変数だけを通す', () => {
		const env = buildAgentEnv(SOURCE, { kind: 'oauth', value: 'tok' });
		expect(env.PATH).toBe('/usr/bin');
		expect(env.HOME).toBe('/home/runner');
		expect(env.TMPDIR).toBe('/tmp');
	});

	test('GitHub のトークンを渡さない', () => {
		const env = buildAgentEnv(SOURCE, { kind: 'oauth', value: 'tok' });
		expect(env.GITHUB_TOKEN).toBeUndefined();
		expect(env.GH_TOKEN).toBeUndefined();
		expect(env['INPUT_GITHUB-TOKEN']).toBeUndefined();
		expect(env.ACTIONS_RUNTIME_TOKEN).toBeUndefined();
	});

	test('input 由来の環境変数を一切渡さない', () => {
		const env = buildAgentEnv(SOURCE, { kind: 'oauth', value: 'tok' });
		for (const key of Object.keys(env)) {
			expect(key.startsWith('INPUT_')).toBe(false);
		}
	});

	test('許可リストに無い変数を渡さない', () => {
		const env = buildAgentEnv(SOURCE, { kind: 'oauth', value: 'tok' });
		expect(env.SOME_OTHER_VAR).toBeUndefined();
	});

	test('oauth なら CLAUDE_CODE_OAUTH_TOKEN を設定する', () => {
		const env = buildAgentEnv(SOURCE, { kind: 'oauth', value: 'tok' });
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
	});

	test('apiKey なら ANTHROPIC_API_KEY を設定する', () => {
		const env = buildAgentEnv(SOURCE, { kind: 'apiKey', value: 'sk-x' });
		expect(env.ANTHROPIC_API_KEY).toBe('sk-x');
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
	});
});
