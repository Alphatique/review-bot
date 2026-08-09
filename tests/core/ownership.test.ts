import { describe, expect, test } from 'bun:test';
import { buildStickyMarker, REVIEW_MARKER } from '../../src/core/marker';
import {
	isOwnAuthor,
	type IssueCommentLike,
	type ReviewLike,
	selectOwnVerdict,
	selectSticky,
} from '../../src/core/ownership';

const BOT = { login: 'github-actions[bot]', type: 'Bot' };
const HUMAN = { login: 'someone', type: 'User' };
const OTHER_APP = { login: 'other-app[bot]', type: 'Bot' };

function review(overrides: Partial<ReviewLike> = {}): ReviewLike {
	return {
		id: 1,
		state: 'CHANGES_REQUESTED',
		body: `本文\n\n${REVIEW_MARKER}`,
		user: BOT,
		...overrides,
	};
}

function comment(overrides: Partial<IssueCommentLike> = {}): IssueCommentLike {
	return {
		id: 10,
		body: `サマリ\n${buildStickyMarker('a1b2c3d')}`,
		user: BOT,
		...overrides,
	};
}

describe('isOwnAuthor', () => {
	test('login が一致すれば自分', () => {
		expect(isOwnAuthor(HUMAN, 'someone')).toBe(true);
	});

	test('login が違えば自分ではない', () => {
		expect(isOwnAuthor(HUMAN, 'someone-else')).toBe(false);
	});

	test('login が null なら Bot 判定にフォールバックする', () => {
		expect(isOwnAuthor(BOT, null)).toBe(true);
		expect(isOwnAuthor(HUMAN, null)).toBe(false);
	});

	test('login を確定できていれば type が Bot でも一致を要求する', () => {
		expect(isOwnAuthor(OTHER_APP, 'github-actions[bot]')).toBe(false);
	});

	test('投稿者が不明なら自分ではない', () => {
		expect(isOwnAuthor(null, null)).toBe(false);
		expect(isOwnAuthor(undefined, 'someone')).toBe(false);
	});
});

describe('selectOwnVerdict', () => {
	test('自分の最新の判定を返す', () => {
		const verdict = selectOwnVerdict(
			[
				review({ id: 1, state: 'APPROVED' }),
				review({ id: 2, state: 'CHANGES_REQUESTED' }),
			],
			null,
		);
		expect(verdict).toEqual({ id: 2, state: 'CHANGES_REQUESTED' });
	});

	test('判定が無ければ null', () => {
		expect(selectOwnVerdict([], null)).toBeNull();
	});

	test('DISMISSED に当たったらそれより古い判定を掘り出さない', () => {
		const verdict = selectOwnVerdict(
			[
				review({ id: 1, state: 'CHANGES_REQUESTED' }),
				review({ id: 2, state: 'DISMISSED' }),
			],
			null,
		);
		expect(verdict).toBeNull();
	});

	test('COMMENTED は判定を上書きしないので読み飛ばす', () => {
		const verdict = selectOwnVerdict(
			[
				review({ id: 1, state: 'CHANGES_REQUESTED' }),
				review({ id: 2, state: 'COMMENTED' }),
			],
			null,
		);
		expect(verdict).toEqual({ id: 1, state: 'CHANGES_REQUESTED' });
	});

	test('PENDING も読み飛ばす', () => {
		const verdict = selectOwnVerdict(
			[
				review({ id: 1, state: 'APPROVED' }),
				review({ id: 2, state: 'PENDING' }),
			],
			null,
		);
		expect(verdict).toEqual({ id: 1, state: 'APPROVED' });
	});

	test('マーカーが無い Review は自分のものとみなさない', () => {
		expect(selectOwnVerdict([review({ body: '本文だけ' })], null)).toBeNull();
	});

	test('他 App の Review は Bot でも拾わない（マーカーとの AND）', () => {
		const verdict = selectOwnVerdict(
			[review({ id: 1, user: OTHER_APP, body: '他 App の本文' })],
			null,
		);
		expect(verdict).toBeNull();
	});

	test('人間の REQUEST_CHANGES は自分の判定ではない', () => {
		expect(selectOwnVerdict([review({ user: HUMAN })], null)).toBeNull();
	});

	test('他人の DISMISSED では打ち切らない', () => {
		const verdict = selectOwnVerdict(
			[
				review({ id: 1, state: 'CHANGES_REQUESTED' }),
				review({ id: 2, state: 'DISMISSED', user: HUMAN }),
			],
			null,
		);
		expect(verdict).toEqual({ id: 1, state: 'CHANGES_REQUESTED' });
	});

	test('login を指定すればその投稿者の判定だけを見る', () => {
		const verdict = selectOwnVerdict(
			[review({ id: 1, user: { login: 'reviewer-pat', type: 'User' } })],
			'reviewer-pat',
		);
		expect(verdict).toEqual({ id: 1, state: 'CHANGES_REQUESTED' });
	});
});

describe('selectSticky', () => {
	test('自分の sticky を返す', () => {
		expect(selectSticky([comment()], null)).toEqual({
			commentId: 10,
			body: `サマリ\n${buildStickyMarker('a1b2c3d')}`,
		});
	});

	test('マーカーが無いコメントは無視する', () => {
		expect(
			selectSticky([comment({ body: 'ただのコメント' })], null),
		).toBeNull();
	});

	test('他人が投稿した偽の sticky を採用しない', () => {
		expect(selectSticky([comment({ user: HUMAN })], null)).toBeNull();
	});

	test('偽の sticky があっても自分のものを選ぶ', () => {
		const found = selectSticky(
			[comment({ id: 9, user: HUMAN }), comment({ id: 11 })],
			null,
		);
		expect(found?.commentId).toBe(11);
	});

	test('候補が無ければ null', () => {
		expect(selectSticky([], null)).toBeNull();
	});
});
