import { BLOCK_ON_VALUES, type BlockOn } from './core/decision';
import { DEFAULT_EXCLUDE } from './core/diff';
import { type Language, LANGUAGES } from './core/i18n';
import type { ParseResult } from './core/schema';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface Config {
	auth: { kind: 'oauth' | 'apiKey'; value: string };
	githubToken: string;
	repo: string;
	prNumber: number;
	instructionsFile: string;
	exclude: string[];
	language: Language;
	blockOn: BlockOn;
	approve: boolean;
	autoResolve: boolean;
	failOnError: boolean;
	failOnIncomplete: boolean;
	model: string;
	effort: Effort;
	maxRetries: number;
	timeoutMs: number;
	maxCostUsd: number;
	diffMaxBytes: number;
}

export type RawInputs = Record<string, string | undefined>;

export function loadConfig(input: RawInputs): ParseResult<Config> {
	const errors: string[] = [];

	const oauth = str(input, 'claude-code-oauth-token');
	const apiKey = str(input, 'anthropic-api-key');
	const auth = oauth
		? ({ kind: 'oauth', value: oauth } as const)
		: apiKey
			? ({ kind: 'apiKey', value: apiKey } as const)
			: null;
	if (!auth) {
		errors.push(
			'either claude-code-oauth-token or anthropic-api-key is required',
		);
	}

	const githubToken = str(input, 'github-token');
	if (!githubToken) errors.push('github-token is required');

	const repo = str(input, 'repo');
	if (!repo) errors.push('repo is required');

	const prNumber = int(input, 'pr-number', errors, { min: 1 });
	const language = pick(input, 'language', LANGUAGES, 'en', errors);
	const blockOn = pick(input, 'block-on', BLOCK_ON_VALUES, 'major', errors);
	const effort = pick(input, 'effort', EFFORTS, 'high', errors);
	const maxRetries = int(input, 'max-retries', errors, { min: 1, fallback: 3 });
	const timeoutMinutes = num(input, 'timeout-minutes', errors, {
		min: 0.1,
		fallback: 8,
	});
	const maxCostUsd = num(input, 'max-cost-usd', errors, {
		min: 0.01,
		fallback: 5,
	});
	const diffMaxBytes = int(input, 'diff-max-bytes', errors, {
		min: 1,
		fallback: 500_000,
	});

	if (errors.length > 0 || !auth) {
		return { ok: false, error: errors.join('; ') };
	}

	return {
		ok: true,
		value: {
			auth,
			githubToken,
			repo,
			prNumber,
			instructionsFile:
				str(input, 'instructions-file') || '.github/review-instructions.md',
			exclude: [...DEFAULT_EXCLUDE, ...lines(input, 'exclude')],
			language,
			blockOn,
			approve: bool(input, 'approve', true),
			autoResolve: bool(input, 'auto-resolve', true),
			failOnError: bool(input, 'fail-on-error', true),
			failOnIncomplete: bool(input, 'fail-on-incomplete', false),
			model: str(input, 'model') || 'claude-sonnet-5',
			effort,
			maxRetries,
			timeoutMs: Math.round(timeoutMinutes * 60_000),
			maxCostUsd,
			diffMaxBytes,
		},
	};
}

function str(input: RawInputs, key: string): string {
	return (input[key] ?? '').trim();
}

function lines(input: RawInputs, key: string): string[] {
	return str(input, key)
		.split('\n')
		.map(line => line.trim())
		.filter(line => line.length > 0 && !line.startsWith('#'));
}

function bool(input: RawInputs, key: string, fallback: boolean): boolean {
	const value = str(input, key).toLowerCase();
	if (value === '') return fallback;
	return value === 'true' || value === '1' || value === 'yes';
}

function pick<T extends string>(
	input: RawInputs,
	key: string,
	allowed: readonly T[],
	fallback: T,
	errors: string[],
): T {
	const value = str(input, key);
	if (value === '') return fallback;
	if (!(allowed as readonly string[]).includes(value)) {
		errors.push(
			`${key} must be one of: ${allowed.join(', ')} (got "${value}")`,
		);
		return fallback;
	}
	return value as T;
}

function num(
	input: RawInputs,
	key: string,
	errors: string[],
	options: { min: number; fallback?: number },
): number {
	const value = str(input, key);
	if (value === '') {
		if (options.fallback !== undefined) return options.fallback;
		errors.push(`${key} is required`);
		return options.min;
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < options.min) {
		errors.push(`${key} must be a number >= ${options.min} (got "${value}")`);
		return options.fallback ?? options.min;
	}
	return parsed;
}

function int(
	input: RawInputs,
	key: string,
	errors: string[],
	options: { min: number; fallback?: number },
): number {
	const value = num(input, key, errors, options);
	return Math.floor(value);
}
