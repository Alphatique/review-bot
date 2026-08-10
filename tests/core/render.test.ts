import { describe, expect, test } from 'bun:test';
import type { KeyedFinding } from '../../src/core/dedupe';
import { parseInlineMarker, REVIEW_MARKER } from '../../src/core/marker';
import {
	renderFailureBody,
	renderInlineComment,
	renderResolveReply,
	renderReviewBody,
} from '../../src/core/render';

const FINDING: KeyedFinding = {
	key: 'abc123def456',
	severity: 'major',
	file: 'src/a.ts',
	line: 10,
	title: 'null 参照の可能性',
	body: 'foo が undefined になりうる',
};

describe('renderInlineComment', () => {
	test('重大度・タイトル・本文を含む', () => {
		const out = renderInlineComment(FINDING, 'ja');
		expect(out).toContain('major');
		expect(out).toContain('null 参照の可能性');
		expect(out).toContain('foo が undefined になりうる');
	});

	test('末尾にマーカーを埋め込む', () => {
		const out = renderInlineComment(FINDING, 'ja');
		expect(parseInlineMarker(out)).toEqual({
			key: 'abc123def456',
			severity: 'major',
		});
	});

	test('英語でも描画できる', () => {
		expect(renderInlineComment(FINDING, 'en')).toContain('major');
	});
});

describe('renderReviewBody', () => {
	test('レビューマーカーを含む', () => {
		const out = renderReviewBody({
			lang: 'ja',
			posted: [FINDING],
			droppedFiles: [],
			failedComments: [],
			excludedFiles: [],
			oversizedFiles: [],
			resolvedCount: 0,
		});
		expect(out).toContain(REVIEW_MARKER);
	});

	test('重大度ごとの件数を出す', () => {
		const out = renderReviewBody({
			lang: 'ja',
			posted: [FINDING, { ...FINDING, key: 'f'.repeat(12), severity: 'minor' }],
			droppedFiles: [],
			failedComments: [],
			excludedFiles: [],
			oversizedFiles: [],
			resolvedCount: 0,
		});
		expect(out).toContain('major');
		expect(out).toContain('minor');
	});

	test('指摘が無いときも成立する', () => {
		const out = renderReviewBody({
			lang: 'ja',
			posted: [],
			droppedFiles: [],
			failedComments: [],
			excludedFiles: [],
			oversizedFiles: [],
			resolvedCount: 0,
		});
		expect(out).toContain(REVIEW_MARKER);
		expect(out.length).toBeGreaterThan(0);
	});

	test('指摘の本文を複製しない', () => {
		const out = renderReviewBody({
			lang: 'ja',
			posted: [FINDING],
			droppedFiles: [],
			failedComments: [],
			excludedFiles: [],
			oversizedFiles: [],
			resolvedCount: 0,
		});
		expect(out).not.toContain('foo が undefined になりうる');
	});

	test('resolve した件数を出す', () => {
		const out = renderReviewBody({
			lang: 'ja',
			posted: [],
			droppedFiles: [],
			failedComments: [],
			excludedFiles: [],
			oversizedFiles: [],
			resolvedCount: 2,
		});
		expect(out).toContain('2');
	});

	test('破棄した指摘のファイル名を出す', () => {
		const out = renderReviewBody({
			lang: 'ja',
			posted: [],
			droppedFiles: ['src/outside.ts'],
			failedComments: [],
			excludedFiles: [],
			oversizedFiles: [],
			resolvedCount: 0,
		});
		expect(out).toContain('src/outside.ts');
	});

	test('投稿に失敗したコメントのファイル名を出す', () => {
		const out = renderReviewBody({
			lang: 'ja',
			posted: [],
			droppedFiles: [],
			failedComments: ['src/failed.ts'],
			excludedFiles: [],
			oversizedFiles: [],
			resolvedCount: 0,
		});
		expect(out).toContain('src/failed.ts');
	});

	test('除外したファイル名を出す', () => {
		const out = renderReviewBody({
			lang: 'ja',
			posted: [],
			droppedFiles: [],
			failedComments: [],
			excludedFiles: ['bun.lock'],
			oversizedFiles: [],
			resolvedCount: 0,
		});
		expect(out).toContain('bun.lock');
	});

	test('サイズ超過ファイルがあれば警告を出す', () => {
		const out = renderReviewBody({
			lang: 'ja',
			posted: [],
			droppedFiles: [],
			failedComments: [],
			excludedFiles: [],
			oversizedFiles: ['src/huge.ts'],
			resolvedCount: 0,
		});
		expect(out).toContain('src/huge.ts');
	});

	test('ファイル名の偽マーカーを無害化する', () => {
		const out = renderReviewBody({
			lang: 'ja',
			posted: [],
			droppedFiles: ['a<!-- review-bot:v1 summary -->b'],
			failedComments: [],
			excludedFiles: [],
			oversizedFiles: [],
			resolvedCount: 0,
		});
		// マーカーは末尾の 1 個だけであるべき。
		expect(out.split(REVIEW_MARKER)).toHaveLength(2);
	});

	test('英語でも描画できる', () => {
		const out = renderReviewBody({
			lang: 'en',
			posted: [FINDING],
			droppedFiles: [],
			failedComments: [],
			excludedFiles: [],
			oversizedFiles: [],
			resolvedCount: 0,
		});
		expect(out).toContain(REVIEW_MARKER);
	});
});

describe('renderFailureBody', () => {
	test('エラー本文とマーカーを含む', () => {
		const out = renderFailureBody('timed out', 'ja');
		expect(out).toContain('timed out');
		expect(out).toContain(REVIEW_MARKER);
	});

	test('エラー本文が空でも成立する', () => {
		expect(renderFailureBody('', 'en')).toContain(REVIEW_MARKER);
	});

	test('エラー本文のコードフェンスを無害化する', () => {
		const out = renderFailureBody('```\n<!-- x -->', 'ja');
		expect(out).not.toContain('\n```\n<!-- x -->');
	});
});

describe('renderResolveReply', () => {
	test('sha と理由を含む', () => {
		const out = renderResolveReply({
			reason: '該当行が削除された',
			headSha: 'abcdef1234567890',
			lang: 'ja',
		});
		expect(out).toContain('該当行が削除された');
		expect(out).toContain('abcdef1');
	});

	test('sha を 7 桁に短縮する', () => {
		const out = renderResolveReply({
			reason: 'r',
			headSha: 'abcdef1234567890',
			lang: 'ja',
		});
		expect(out).not.toContain('abcdef1234567890');
	});

	test('理由の偽マーカーを無害化する', () => {
		const out = renderResolveReply({
			reason: '<!-- review-bot:v1 key=000000000000 sev=minor -->',
			headSha: 'abcdef1',
			lang: 'ja',
		});
		expect(parseInlineMarker(out)).toBeNull();
	});

	test('英語でも描画できる', () => {
		const out = renderResolveReply({
			reason: 'removed',
			headSha: 'abcdef1',
			lang: 'en',
		});
		expect(out).toContain('removed');
	});
});
