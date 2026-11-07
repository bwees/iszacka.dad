// Catch the Stork: game tokens, validation and the leaderboard (src/lib/stork.ts), on a real
// SQLite with the repo's migrations.

import { describe, expect, it } from 'vitest';
import {
	DAILY_SCORE_CAP,
	LEADERBOARD_SIZE,
	LEADERBOARD_TTL_MS,
	MAX_SCORE,
	SCORE_SLACK,
	SETTING_KEY,
	TOKEN_TTL_MS,
	isRudeInitials,
	issueGameToken,
	londonDayStartIso,
	maxPlausibleScore,
	normaliseInitials,
	parseScore,
	submitScore,
	topScores,
	verifyGameToken,
} from '../src/lib/stork';
import { sqliteD1 } from './email-announce-d1';

function envWithDb() {
	const { D1, db, counts } = sqliteD1();
	return { env: { DB: D1 } as unknown as Env, db, counts };
}

const NOW = Date.parse('2026-11-07T12:00:00.000Z');

describe('initials', () => {
	it('uppercases and trims exactly three letters', () => {
		expect(normaliseInitials('abc')).toBe('ABC');
		expect(normaliseInitials('  xYz ')).toBe('XYZ');
	});

	it('refuses anything else', () => {
		for (const bad of ['AB', 'ABCD', 'A1C', 'ÄBC', 'A C', '', '<b>', 123, null, undefined, ['ABC']]) {
			expect(normaliseInitials(bad), String(bad)).toBeNull();
		}
	});

	it('knows a few words the stork will not print', () => {
		expect(isRudeInitials('ASS')).toBe(true);
		expect(isRudeInitials('WTF')).toBe(true);
		expect(isRudeInitials('ABC')).toBe(false);
		expect(isRudeInitials('ZAK')).toBe(false);
	});
});

describe('scores', () => {
	it('parses whole numbers from 1 to MAX_SCORE', () => {
		expect(parseScore('12')).toBe(12);
		expect(parseScore(12)).toBe(12);
		expect(parseScore(' 7 ')).toBe(7);
		expect(parseScore(MAX_SCORE)).toBe(MAX_SCORE);
		for (const bad of ['0', 0, '-1', -1, '1.5', 1.5, 'abc', '', MAX_SCORE + 1, '1e3', Number.NaN, Infinity, null]) {
			expect(parseScore(bad), String(bad)).toBeNull();
		}
	});

	it('allows a head start plus four points a second', () => {
		expect(maxPlausibleScore(0)).toBe(SCORE_SLACK);
		expect(maxPlausibleScore(-5000)).toBe(SCORE_SLACK);
		expect(maxPlausibleScore(10_000)).toBe(SCORE_SLACK + 40);
		expect(maxPlausibleScore(10 * TOKEN_TTL_MS)).toBe(MAX_SCORE);
	});

	it('resets the daily cap at London midnight, BST included', () => {
		expect(londonDayStartIso(NOW)).toBe('2026-11-07T00:00:00.000Z');
		expect(londonDayStartIso(Date.parse('2026-07-01T12:00:00Z'))).toBe('2026-06-30T23:00:00.000Z');
		// 00:30 on 2 July in London is still 1 July in UTC.
		expect(londonDayStartIso(Date.parse('2026-07-01T23:30:00Z'))).toBe('2026-07-01T23:00:00.000Z');
	});
});

describe('game tokens', () => {
	it('round-trips: signed start time and a nonce', async () => {
		const { env } = envWithDb();
		const { token, startedAt } = await issueGameToken(env, NOW);
		expect(startedAt).toBe(NOW);
		const check = await verifyGameToken(env, token, NOW + 60_000);
		expect(check).toEqual({ ok: true, startedAt: NOW, game: token.split('.')[1] });
	});

	it('keeps its secret in settings, created once', async () => {
		const { env, db } = envWithDb();
		await issueGameToken(env, NOW);
		await issueGameToken(env, NOW);
		const rows = db.prepare('SELECT value FROM settings WHERE key = ?').all(SETTING_KEY) as Array<{ value: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0]?.value.length).toBeGreaterThanOrEqual(32);
	});

	it('gives every game its own nonce', async () => {
		const { env } = envWithDb();
		const a = await issueGameToken(env, NOW);
		const b = await issueGameToken(env, NOW);
		expect(a.token.split('.')[1]).not.toBe(b.token.split('.')[1]);
	});

	it('refuses a backdated start time', async () => {
		const { env } = envWithDb();
		const { token } = await issueGameToken(env, NOW);
		const [, nonce, sig] = token.split('.');
		const backdated = `${(NOW - 3_600_000).toString(36)}.${nonce}.${sig}`;
		expect(await verifyGameToken(env, backdated, NOW)).toEqual({ ok: false, reason: 'forged' });
	});

	it("refuses another database's tokens and a tampered signature", async () => {
		const one = envWithDb().env;
		const two = envWithDb().env;
		const { token } = await issueGameToken(one, NOW);
		expect(await verifyGameToken(two, token, NOW)).toEqual({ ok: false, reason: 'forged' });
		const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
		expect((await verifyGameToken(one, flipped, NOW)).ok).toBe(false);
	});

	it('expires, and refuses tokens from the future', async () => {
		const { env } = envWithDb();
		const { token } = await issueGameToken(env, NOW);
		expect(await verifyGameToken(env, token, NOW + TOKEN_TTL_MS + 1)).toEqual({ ok: false, reason: 'expired' });
		expect(await verifyGameToken(env, token, NOW - 60_000)).toEqual({ ok: false, reason: 'future' });
	});

	it('calls nonsense malformed', async () => {
		const { env } = envWithDb();
		for (const bad of ['', 'abc', 'a.b.c', `${NOW.toString(36)}.short.sig`, null, 42, {}]) {
			expect(await verifyGameToken(env, bad, NOW), String(bad)).toEqual({ ok: false, reason: 'malformed' });
		}
	});
});

describe('submitScore and the leaderboard', () => {
	const entry = (initials: string, score: number, game: string, ipHash = 'hash-a', now = NOW) => ({ initials, score, game, ipHash, now });

	it('stores a score and ranks it, in one round trip', async () => {
		const { env, counts } = envWithDb();
		const before = counts.roundTrips;
		const result = await submitScore(env, entry('ABC', 10, 'game-1'));
		expect(counts.roundTrips - before).toBe(1);
		expect(result).toMatchObject({ ok: true, rank: 1 });
		if (!result.ok) return;
		expect(result.scores).toEqual([{ rank: 1, initials: 'ABC', score: 10, at: '2026-11-07T12:00:00.000Z' }]);
	});

	it('ranks higher scores first and ties by who got there first', async () => {
		const { env } = envWithDb();
		await submitScore(env, entry('AAA', 10, 'g1', 'h1'));
		await submitScore(env, entry('BBB', 30, 'g2', 'h2'));
		const tie = await submitScore(env, entry('CCC', 10, 'g3', 'h3'));
		expect(tie).toMatchObject({ ok: true, rank: 3 });
		const top = await topScores(env, { fresh: true });
		expect(top.map((s) => `${s.rank}:${s.initials}:${s.score}`)).toEqual(['1:BBB:30', '2:AAA:10', '3:CCC:10']);
	});

	it('takes one score per game', async () => {
		const { env } = envWithDb();
		expect((await submitScore(env, entry('ABC', 5, 'same'))).ok).toBe(true);
		expect(await submitScore(env, entry('XYZ', 50, 'same', 'hash-b'))).toEqual({ ok: false, code: 'duplicate' });
	});

	it(`caps a connection at ${DAILY_SCORE_CAP} scores per London day`, async () => {
		const { env } = envWithDb();
		for (let i = 0; i < DAILY_SCORE_CAP; i++) expect((await submitScore(env, entry('ABC', i + 1, `g${i}`))).ok).toBe(true);
		expect(await submitScore(env, entry('ABC', 99, 'g-extra'))).toEqual({ ok: false, code: 'limit' });
		// Someone else on another connection is fine, and so is tomorrow.
		expect((await submitScore(env, entry('XYZ', 99, 'g-other', 'hash-b'))).ok).toBe(true);
		expect((await submitScore(env, entry('ABC', 99, 'g-tomorrow', 'hash-a', NOW + 86_400_000))).ok).toBe(true);
	});

	it(`shows the top ${LEADERBOARD_SIZE}, cached for about 30 seconds`, async () => {
		const { env, counts } = envWithDb();
		for (let i = 0; i < LEADERBOARD_SIZE + 3; i++) await submitScore(env, entry('ABC', i + 1, `g${i}`, `h${i}`));
		const top = await topScores(env, { fresh: true, now: NOW });
		expect(top).toHaveLength(LEADERBOARD_SIZE);
		expect(top[0]?.score).toBe(LEADERBOARD_SIZE + 3);
		const trips = counts.roundTrips;
		await topScores(env, { now: NOW + LEADERBOARD_TTL_MS - 1 });
		expect(counts.roundTrips).toBe(trips);
		await topScores(env, { now: NOW + LEADERBOARD_TTL_MS + 1 });
		expect(counts.roundTrips).toBe(trips + 1);
	});

	it('refreshes the cached leaderboard when a score lands', async () => {
		const { env } = envWithDb();
		expect(await topScores(env, { now: NOW })).toEqual([]);
		await submitScore(env, entry('NEW', 3, 'g1'));
		expect((await topScores(env, { now: NOW + 1 })).map((s) => s.initials)).toEqual(['NEW']);
	});

	it('lets the schema refuse what validation would', () => {
		const { db } = envWithDb();
		const insert = (initials: string, score: number) => () =>
			db.prepare('INSERT INTO stork_scores (initials, score) VALUES (?, ?)').run(initials, score);
		expect(insert('AB', 1)).toThrow();
		expect(insert('abc', 1)).toThrow();
		expect(insert('ABC', -1)).toThrow();
		expect(insert('ABC', 1)).not.toThrow();
	});
});
