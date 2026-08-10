import { isAtLeastAsSevere, type Severity } from './schema';
import type { LiveVerdict } from './verdict';

export type ReviewEvent = 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE' | 'NONE';

export const BLOCK_ON_VALUES = ['none', 'critical', 'major', 'minor'] as const;
export type BlockOn = (typeof BLOCK_ON_VALUES)[number];

export interface DecisionInput {
	/** 投稿後に未解決として残る指摘の severity 一覧。 */
	outstanding: readonly Severity[];
	blockOn: BlockOn;
	approve: boolean;
	/**
	 * 承認の根拠にならない要素が今回の実行に含まれるか。
	 * スレッドとして追跡できない指摘、投稿に失敗した指摘、サイズ超過で
	 * レビューされなかったファイルのいずれかがあれば true。
	 * true なら承認しない。追跡できない・レビューできなかった問題を
	 * 残したまま緑にしない。
	 */
	hasUntrackedFindings: boolean;
	/**
	 * 判定を提出できるか。
	 * bot が作成した PR に REQUEST_CHANGES / APPROVE を出すと 422 になる。
	 */
	canSubmitVerdict: boolean;
	/** GitHub 上でいま生きている自分の判定。 */
	liveVerdict: LiveVerdict | null;
	/**
	 * 今回報告すべき新しい内容があるか。
	 * 投稿する指摘・破棄した指摘・投稿に失敗した指摘のいずれかがあれば true。
	 * 破棄だけの回に NONE を返すと、破棄した事実が誰にも届かない。
	 */
	hasSomethingToReport: boolean;
}

export function decideEvent(input: DecisionInput): ReviewEvent {
	const blocking =
		input.blockOn !== 'none' &&
		input.outstanding.some(severity =>
			isAtLeastAsSevere(severity, input.blockOn as Severity),
		);

	let desired: Exclude<ReviewEvent, 'NONE'>;
	if (blocking) desired = 'REQUEST_CHANGES';
	else if (input.approve && !input.hasUntrackedFindings) desired = 'APPROVE';
	else desired = 'COMMENT';

	if (!input.canSubmitVerdict && desired !== 'COMMENT') desired = 'COMMENT';

	// COMMENT は判定を上書きしないので、運ぶものが無ければ出す意味がない。
	if (desired === 'COMMENT') {
		return input.hasSomethingToReport ? 'COMMENT' : 'NONE';
	}

	// 同じ判定を出し直しても GitHub の状態は変わらず、通知だけが増える。
	// ReviewEvent ('REQUEST_CHANGES' / 'APPROVE') と GitHub の Review state
	// ('CHANGES_REQUESTED' / 'APPROVED') は語彙が違うので変換して比べる。
	const liveEquivalent = LIVE_STATE_BY_EVENT[desired];
	if (input.liveVerdict?.state === liveEquivalent) {
		return input.hasSomethingToReport ? 'COMMENT' : 'NONE';
	}

	return desired;
}

const LIVE_STATE_BY_EVENT: Record<
	'REQUEST_CHANGES' | 'APPROVE',
	LiveVerdict['state']
> = {
	REQUEST_CHANGES: 'CHANGES_REQUESTED',
	APPROVE: 'APPROVED',
};
