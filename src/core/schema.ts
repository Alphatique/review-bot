import { z } from 'zod';

export const SEVERITIES = ['critical', 'major', 'minor'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_ORDER: Record<Severity, number> = {
	critical: 0,
	major: 1,
	minor: 2,
};

/** a が b と同等以上に重大か。 */
export function isAtLeastAsSevere(a: Severity, b: Severity): boolean {
	return SEVERITY_ORDER[a] <= SEVERITY_ORDER[b];
}

export interface Finding {
	severity: Severity;
	file: string;
	line: number | null;
	title: string;
	body: string;
}

/**
 * Agent SDK の `tool()` に渡す zod raw shape。
 * description はそのままモデルへの指示になるため、ここが実質的なプロンプトの一部。
 */
export const submitReviewInputShape = {
	findings: z
		.array(
			z.object({
				severity: z
					.enum(SEVERITIES)
					.describe(
						'critical=セキュリティ/データ破壊/本番停止級, major=明白な機能バグ/重大な性能問題, minor=ベストプラクティス違反/軽微なバグ/保守性',
					),
				file: z.string().min(1).describe('リポジトリルートからの相対パス'),
				line: z
					.number()
					.int()
					.min(1)
					.nullable()
					.describe(
						'対象行番号（1始まり、変更後のファイル基準）。特定できなければ null',
					),
				title: z.string().min(1).describe('指摘の短いタイトル'),
				body: z
					.string()
					.min(1)
					.describe('2〜5行の説明。可能なら修正案を含める'),
			}),
		)
		.describe('検出した指摘の配列。指摘が無ければ空配列'),
};

const findingsPayloadSchema = z.object(submitReviewInputShape);

export type ParseResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: string };

/** モデルがツールに渡した入力を検証する。 */
export function parseFindings(input: unknown): ParseResult<Finding[]> {
	const result = findingsPayloadSchema.safeParse(input);
	if (!result.success) {
		const summary = result.error.issues
			.map(issue => `${issue.path.join('.')}: ${issue.message}`)
			.join('; ');
		return { ok: false, error: summary };
	}
	return { ok: true, value: result.data.findings };
}
