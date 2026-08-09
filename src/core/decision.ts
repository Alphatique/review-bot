import { isAtLeastAsSevere, type Severity } from './schema';

/** Review として提出できるイベント。 */
export type ReviewEvent = 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';

/** NONE は「Review を作らない」を表す。 */
export type EventDecision = ReviewEvent | 'NONE';

export const REQUEST_CHANGES_ON_VALUES = [
	'none',
	'critical',
	'major',
	'minor',
] as const;
export type RequestChangesOn = (typeof REQUEST_CHANGES_ON_VALUES)[number];

/** GitHub 上で生きている（dismiss されていない）自分の Review の判定。 */
export type OwnVerdictState = 'APPROVED' | 'CHANGES_REQUESTED';

export interface DecisionInput {
	/** 今回のレビューで新たに投稿する指摘。 */
	newFindings: readonly { severity: Severity }[];
	/** GitHub 上に既にある bot の指摘。 */
	existing: readonly { severity: Severity; isResolved: boolean }[];
	threshold: RequestChangesOn;
	/**
	 * APPROVE / REQUEST_CHANGES を提出できるか。
	 * bot 自身が作成した PR にはどちらも提出できず 422 になるため false を渡す。
	 */
	canSubmitVerdict: boolean;
	/** approve input。既定 false。 */
	approve: boolean;
	/** GitHub 上で生きている自分の判定。COMMENTED は判定ではないので含めない。 */
	currentVerdict: OwnVerdictState | null;
}

export function decideEvent(input: DecisionInput): EventDecision {
	const unresolved = input.existing.filter(e => !e.isResolved);
	// 投稿後の未解決件数。board を組み立てる前に判定するため、ここで直接数える。
	const outstandingAfter = unresolved.length + input.newFindings.length;

	if (input.approve && input.canSubmitVerdict && outstandingAfter === 0) {
		return 'APPROVE';
	}

	if (input.threshold !== 'none' && input.canSubmitVerdict) {
		const threshold: Severity = input.threshold;
		const hasNew = input.newFindings.some(f =>
			isAtLeastAsSevere(f.severity, threshold),
		);
		const hasUnresolved = unresolved.some(e =>
			isAtLeastAsSevere(e.severity, threshold),
		);
		// 既に CHANGES_REQUESTED が生きているなら再提出しても状態は変わらない。
		// 毎回出すと push のたびにコメント 0 件の Review と通知が積み上がる。
		const alreadyBlocking = input.currentVerdict === 'CHANGES_REQUESTED';
		if (hasNew || (hasUnresolved && !alreadyBlocking)) return 'REQUEST_CHANGES';
	}

	return input.newFindings.length > 0 ? 'COMMENT' : 'NONE';
}
