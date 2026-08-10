import {
	createSdkMcpServer,
	query,
	tool,
} from '@anthropic-ai/claude-agent-sdk';
import {
	type Finding,
	parseSubmission,
	type ResolvedFinding,
	submitReviewInputShape,
} from '../core/schema';

/** Agent SDK が MCP ツールに付ける名前は mcp__<server>__<tool> になる。 */
export const SUBMIT_TOOL_NAME = 'mcp__review__submit_review';

const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'] as const;
const FORBIDDEN_TOOLS = [
	'Bash',
	'Write',
	'Edit',
	'NotebookEdit',
	'WebFetch',
	'WebSearch',
	'Task',
] as const;

/**
 * Agent サブプロセスに渡す環境変数。許可リスト方式。
 * SDK の env は追加ではなく完全な差し替えなので、ここに無いものは一切渡らない。
 * サブプロセスが動かない場合はこのリストを広げること（denylist に戻さない）。
 */
const ENV_ALLOWLIST = [
	'PATH',
	'HOME',
	'TMPDIR',
	'TMP',
	'TEMP',
	'LANG',
	'LC_ALL',
	'SHELL',
	'USER',
	'LOGNAME',
	'NODE_OPTIONS',
] as const;

export function buildAgentEnv(
	source: NodeJS.ProcessEnv,
	auth: { kind: 'oauth' | 'apiKey'; value: string },
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of ENV_ALLOWLIST) {
		const value = source[key];
		if (value !== undefined) env[key] = value;
	}
	if (auth.kind === 'oauth') env.CLAUDE_CODE_OAUTH_TOKEN = auth.value;
	else env.ANTHROPIC_API_KEY = auth.value;
	return env;
}

export type AgentOutcome =
	| { ok: true; findings: Finding[]; resolved: ResolvedFinding[] }
	| { ok: false; error: string };

export interface RunAgentInput {
	prompt: string;
	model: string;
	effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
	cwd: string;
	timeoutMs: number;
	maxBudgetUsd: number;
	env: Record<string, string>;
	log: (message: string) => void;
}

/**
 * Agent を 1 回実行し、submit_review ツールに渡された指摘を取り出す。
 * ツールが呼ばれなければ失敗として扱い、呼び出し側がリトライする。
 */
export async function runAgent(input: RunAgentInput): Promise<AgentOutcome> {
	let captured: unknown = null;
	let callCount = 0;

	const submitReview = tool(
		'submit_review',
		'レビュー結果を報告する。新しく見つけた指摘と、既に解消している未解決指摘を、レビューが終わったら必ず 1 回だけまとめて報告すること。',
		submitReviewInputShape,
		async args => {
			callCount += 1;
			captured = args;
			return { content: [{ type: 'text' as const, text: 'Review received.' }] };
		},
		// 既定では deferred tool になり、モデルが ToolSearch を経由しないと
		// 呼べない。レビュー結果の報告経路はこれ 1 本なので常に見せる。
		{ alwaysLoad: true },
	);

	const server = createSdkMcpServer({
		name: 'review',
		version: '1.0.0',
		tools: [submitReview],
	});

	const abortController = new AbortController();
	const timer = setTimeout(() => abortController.abort(), input.timeoutMs);
	let timedOut = false;
	abortController.signal.addEventListener('abort', () => {
		timedOut = true;
	});

	const session = query({
		prompt: input.prompt,
		options: {
			mcpServers: { review: server },
			allowedTools: [...READ_ONLY_TOOLS, SUBMIT_TOOL_NAME],
			disallowedTools: [...FORBIDDEN_TOOLS],
			// 実行環境やリポジトリの設定を読み込ませない。省略は不可。
			settingSources: [],
			model: input.model,
			effort: input.effort,
			cwd: input.cwd,
			maxBudgetUsd: input.maxBudgetUsd,
			abortController,
			env: input.env,
		},
	});

	try {
		for await (const message of session) {
			if (message.type === 'assistant') {
				for (const block of message.message.content) {
					if (block.type === 'tool_use') input.log(`tool: ${block.name}`);
				}
			}
			if (message.type === 'result') {
				input.log(`agent result: ${JSON.stringify(message).slice(0, 500)}`);
			}
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			error: timedOut ? `agent timed out after ${input.timeoutMs}ms` : detail,
		};
	} finally {
		clearTimeout(timer);
		session.close();
	}

	if (timedOut) {
		return { ok: false, error: `agent timed out after ${input.timeoutMs}ms` };
	}
	if (callCount === 0) {
		return { ok: false, error: `agent did not call ${SUBMIT_TOOL_NAME}` };
	}

	const parsed = parseSubmission(captured);
	if (!parsed.ok) {
		return { ok: false, error: `invalid tool input: ${parsed.error}` };
	}
	if (parsed.value.resolvedError !== null) {
		// resolved だけが不正だった場合、review 自体は findings を持って成功する。
		// 無言で捨てると気づけないので必ずログに残す。
		input.log(
			`resolved was dropped, findings kept: ${parsed.value.resolvedError}`,
		);
	}
	return {
		ok: true,
		findings: parsed.value.findings,
		resolved: parsed.value.resolved,
	};
}
