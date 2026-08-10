import { describe, expect, test } from 'bun:test';
import { REVIEW_MARKER } from '../../src/core/marker';
import { pickLiveVerdict, type ReviewRecord } from '../../src/core/verdict';

function mine(id: number, state: string): ReviewRecord {
	return { id, body: `本文\n${REVIEW_MARKER}`, state };
}

function theirs(id: number, state: string): ReviewRecord {
	return { id, body: '人間のレビュー', state };
}

describe('pickLiveVerdict', () => {
	test('Review が無ければ null', () => {
		expect(pickLiveVerdict([])).toBeNull();
	});

	test('自分の Review が無ければ null', () => {
		expect(pickLiveVerdict([theirs(1, 'APPROVED')])).toBeNull();
	});

	test('自分の APPROVED を返す', () => {
		expect(pickLiveVerdict([mine(1, 'APPROVED')])).toEqual({
			id: 1,
			state: 'APPROVED',
		});
	});

	test('自分の CHANGES_REQUESTED を返す', () => {
		expect(pickLiveVerdict([mine(1, 'CHANGES_REQUESTED')])).toEqual({
			id: 1,
			state: 'CHANGES_REQUESTED',
		});
	});

	test('新しい方の判定が勝つ', () => {
		const verdict = pickLiveVerdict([
			mine(1, 'CHANGES_REQUESTED'),
			mine(2, 'APPROVED'),
		]);
		expect(verdict).toEqual({ id: 2, state: 'APPROVED' });
	});

	test('COMMENTED は判定を持たないので読み飛ばす', () => {
		const verdict = pickLiveVerdict([
			mine(1, 'CHANGES_REQUESTED'),
			mine(2, 'COMMENTED'),
		]);
		expect(verdict).toEqual({ id: 1, state: 'CHANGES_REQUESTED' });
	});

	test('PENDING も読み飛ばす', () => {
		const verdict = pickLiveVerdict([mine(1, 'APPROVED'), mine(2, 'PENDING')]);
		expect(verdict).toEqual({ id: 1, state: 'APPROVED' });
	});

	test('DISMISSED に当たったら null を返し、古い判定を掘り出さない', () => {
		const verdict = pickLiveVerdict([
			mine(1, 'CHANGES_REQUESTED'),
			mine(2, 'DISMISSED'),
		]);
		expect(verdict).toBeNull();
	});

	test('他人の判定は無視する', () => {
		const verdict = pickLiveVerdict([
			mine(1, 'APPROVED'),
			theirs(2, 'CHANGES_REQUESTED'),
		]);
		expect(verdict).toEqual({ id: 1, state: 'APPROVED' });
	});
});
