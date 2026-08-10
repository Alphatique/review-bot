import type { ThreadInfo } from './thread';

export interface ResolutionPlan {
	toResolve: { thread: ThreadInfo; reason: string }[];
	/** 対象にならなかった key。ログに残す。 */
	ignored: string[];
}

export interface PlanResolutionsInput {
	threads: readonly ThreadInfo[];
	resolved: readonly { key: string; reason: string }[];
}

/**
 * モデルが「解消済み」と報告した key を、実際に触ってよいスレッドに突き合わせる。
 * 未解決のスレッドしか対象にしないので、モデルが余計なものを返しても
 * 人が下した判断は動かない。
 */
export function planResolutions(input: PlanResolutionsInput): ResolutionPlan {
	const open = new Map<string, ThreadInfo>();
	for (const thread of input.threads) {
		if (!thread.isResolved) open.set(thread.key, thread);
	}

	const toResolve: { thread: ThreadInfo; reason: string }[] = [];
	const ignored: string[] = [];
	const seen = new Set<string>();

	for (const entry of input.resolved) {
		if (seen.has(entry.key)) continue;
		seen.add(entry.key);

		const thread = open.get(entry.key);
		if (thread) toResolve.push({ thread, reason: entry.reason });
		else ignored.push(entry.key);
	}

	return { toResolve, ignored };
}
