import { isAtLeastAsSevere, type Severity } from './schema';
import type { ThreadInfo } from './thread';

export type ReviewEvent = 'COMMENT' | 'REQUEST_CHANGES';

export const REQUEST_CHANGES_ON_VALUES = [
	'none',
	'critical',
	'major',
	'minor',
] as const;
export type RequestChangesOn = (typeof REQUEST_CHANGES_ON_VALUES)[number];

export interface DecisionInput {
	/** 今回のレビューで新たに投稿する指摘。 */
	newFindings: readonly { severity: Severity }[];
	/** GitHub 上に既にある bot の指摘。 */
	existing: readonly ThreadInfo[];
	threshold: RequestChangesOn;
	/**
	 * REQUEST_CHANGES を提出できるか。
	 * bot 自身が作成した PR には提出できず 422 になるため false を渡す。
	 */
	canRequestChanges: boolean;
}

export function decideEvent(input: DecisionInput): ReviewEvent {
	if (!input.canRequestChanges) return 'COMMENT';
	if (input.threshold === 'none') return 'COMMENT';

	const threshold: Severity = input.threshold;

	const hasNew = input.newFindings.some(f =>
		isAtLeastAsSevere(f.severity, threshold),
	);
	if (hasNew) return 'REQUEST_CHANGES';

	const hasUnresolved = input.existing.some(
		e => !e.isResolved && isAtLeastAsSevere(e.severity, threshold),
	);
	return hasUnresolved ? 'REQUEST_CHANGES' : 'COMMENT';
}
