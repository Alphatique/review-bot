import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as core from '@actions/core';
import { context } from '@actions/github';
import { loadConfig, type RawInputs } from './config';
import { buildAgentEnv, runAgent } from './io/agent';
import { createGitHubClient } from './io/github';
import { type OrchestrateDeps, runReview } from './orchestrate';

const INPUT_KEYS = [
	'claude-code-oauth-token',
	'anthropic-api-key',
	'github-token',
	'repo',
	'pr-number',
	'mode',
	'instructions-file',
	'exclude',
	'language',
	'request-changes-on',
	'approve',
	'fail-on-error',
	'fail-on-incomplete',
	'model',
	'effort',
	'max-retries',
	'timeout-minutes',
	'max-cost-usd',
	'diff-max-bytes',
] as const;

function collectInputs(): RawInputs {
	const inputs: RawInputs = {};
	for (const key of INPUT_KEYS) inputs[key] = core.getInput(key);

	if (!inputs.repo) inputs.repo = process.env.GITHUB_REPOSITORY ?? '';
	if (!inputs['pr-number']) {
		const number = context.payload.pull_request?.number;
		inputs['pr-number'] = number === undefined ? '' : String(number);
	}
	return inputs;
}

async function main(): Promise<void> {
	const parsed = loadConfig(collectInputs());
	if (!parsed.ok) {
		core.setFailed(`invalid configuration: ${parsed.error}`);
		return;
	}
	const config = parsed.value;

	const [owner, repoName] = config.repo.split('/');
	if (!owner || !repoName) {
		core.setFailed(`invalid repo: ${config.repo}`);
		return;
	}

	const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
	const agentEnv = buildAgentEnv(process.env, config.auth);

	const deps: OrchestrateDeps = {
		github: createGitHubClient({
			token: config.githubToken,
			owner,
			repo: repoName,
			prNumber: config.prNumber,
			log: message => core.info(message),
		}),
		runAgent: ({ prompt }) =>
			runAgent({
				prompt,
				model: config.model,
				effort: config.effort,
				cwd: workspace,
				timeoutMs: config.timeoutMs,
				maxBudgetUsd: config.maxCostUsd,
				env: agentEnv,
				log: message => core.info(`[agent] ${message}`),
			}),
		readInstructions: async path => {
			try {
				return await readFile(resolve(workspace, path), 'utf8');
			} catch {
				core.info(`instructions file not found: ${path} (using defaults)`);
				return null;
			}
		},
		log: message => core.info(message),
	};

	const result = await runReview(deps, config);

	core.setOutput('status', result.status);
	core.setOutput('review-event', result.event);
	core.setOutput('findings-count', String(result.findingsCount));
	core.setOutput('critical-count', String(result.counts.critical));
	core.setOutput('major-count', String(result.counts.major));
	core.setOutput('minor-count', String(result.counts.minor));
	core.setOutput('incomplete-files', String(result.incompleteFiles));
	core.setOutput('cost-usd', result.costUsd.toFixed(4));
	core.setOutput('total-cost-usd', result.totalCostUsd.toFixed(4));

	if (result.status === 'failed' && config.failOnError) {
		core.setFailed(result.error ?? 'review failed');
		return;
	}
	if (result.incompleteFiles > 0 && config.failOnIncomplete) {
		core.setFailed(
			`${result.incompleteFiles} file(s) were not reviewed because the diff exceeded the size limit`,
		);
	}
}

await main();
