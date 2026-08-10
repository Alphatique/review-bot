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
	resolved: z
		.array(
			z.object({
				key: z
					.string()
					.regex(/^[0-9a-f]{12}$/)
					.describe(
						'プロンプトの「未解決の指摘」一覧に載っている key をそのまま書く',
					),
				reason: z
					.string()
					.min(1)
					.describe('現在のコードでどう解消しているかを 1〜2 行で'),
			}),
		)
		.default([])
		.describe(
			'現在のコードで既に解消している未解決指摘。確実なものだけ。無ければ空配列',
		),
};

// findings と resolved は別々に検証する。resolved 側の 1 件の不備で
// findings 全体を巻き添えにしないため（e.g. key の幻覚）。
const findingsSchema = z.object({ findings: submitReviewInputShape.findings });
const resolvedSchema = z.object({ resolved: submitReviewInputShape.resolved });

export interface ResolvedFinding {
	key: string;
	reason: string;
}

export interface Submission {
	findings: Finding[];
	resolved: ResolvedFinding[];
	/** resolved の検証に失敗した理由。成功時は null。 */
	resolvedError: string | null;
}

export type ParseResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: string };

function formatIssues(error: z.ZodError): string {
	return error.issues
		.map(issue => `${issue.path.join('.')}: ${issue.message}`)
		.join('; ');
}

/**
 * モデルがツールに渡した入力を検証する。
 * findings が壊れていれば提出全体を失敗として扱うが、resolved が壊れている
 * だけなら findings は活かし、resolved を空配列に落として resolvedError に
 * 理由を残す（fail-closed: 何も resolve されないだけで、レビューは失われない）。
 */
export function parseSubmission(input: unknown): ParseResult<Submission> {
	const findingsResult = findingsSchema.safeParse(input);
	if (!findingsResult.success) {
		return { ok: false, error: formatIssues(findingsResult.error) };
	}

	const resolvedResult = resolvedSchema.safeParse(input);
	if (!resolvedResult.success) {
		return {
			ok: true,
			value: {
				findings: findingsResult.data.findings,
				resolved: [],
				resolvedError: formatIssues(resolvedResult.error),
			},
		};
	}

	return {
		ok: true,
		value: {
			findings: findingsResult.data.findings,
			resolved: resolvedResult.data.resolved,
			resolvedError: null,
		},
	};
}
