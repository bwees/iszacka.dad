import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ status: 'no' as 'no' | 'soon' | 'yes', dueDate: null as string | null }));
vi.mock('../src/lib/state', () => ({
	getState: vi.fn(async () => ({ status: state.status, statusChangedAt: '2026-01-01T00:00:00.000Z', dueDate: state.dueDate })),
}));

const { MAX_GUESSES_PER_CONNECTION, MAX_GUESSES_PER_PERSON, submitGuess } = await import('../src/lib/pool');

/** Just enough D1 over node:sqlite to run submitGuess's real SQL. */
function sqliteEnv() {
	const db = new DatabaseSync(':memory:');
	db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
		CREATE TABLE guesses (
			id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, guess_at TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'web', ip_hash TEXT, hidden INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));`);
	const D1 = {
		prepare(sql: string) {
			let args: unknown[] = [];
			const stmt = {
				bind(...values: unknown[]) {
					args = values;
					return stmt;
				},
				async run() {
					const r = db.prepare(sql).run(...(args as never[]));
					return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
				},
				async first() {
					return db.prepare(sql).get(...(args as never[])) ?? null;
				},
			};
			return stmt;
		},
	};
	return { DB: D1 } as unknown as Env;
}

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000);
const guessAt = (i: number) => new Date(inDays(10).getTime() + i * 3_600_000).toISOString();

describe('pool limits', () => {
	beforeEach(() => {
		state.status = 'no';
		state.dueDate = inDays(30).toISOString().slice(0, 10);
	});

	it('lets a household share a connection, one name at a time', async () => {
		const env = sqliteEnv();
		for (const [i, name] of ['Sam', 'Alex', 'Jo', 'Robin'].entries()) {
			expect(await submitGuess(env, { name, guessAt: guessAt(i), source: 'web', ipHash: 'house' })).toMatchObject({ ok: true });
		}
	});

	it('caps guesses under one name, with a message that says so', async () => {
		const env = sqliteEnv();
		for (let i = 0; i < MAX_GUESSES_PER_PERSON; i++) {
			expect((await submitGuess(env, { name: 'Sam', guessAt: guessAt(i), source: 'web', ipHash: 'house' })).ok).toBe(true);
		}
		const fourth = await submitGuess(env, { name: 'sam', guessAt: guessAt(9), source: 'web', ipHash: 'house' });
		expect(fourth).toMatchObject({ ok: false, code: 'limit' });
		expect(!fourth.ok && fourth.error).toMatch(/under that name/);
		// Another connection with the same name is someone else.
		expect((await submitGuess(env, { name: 'Sam', guessAt: guessAt(10), source: 'web', ipHash: 'elsewhere' })).ok).toBe(true);
	});

	it('still has a ceiling per connection', async () => {
		const env = sqliteEnv();
		for (let i = 0; i < MAX_GUESSES_PER_CONNECTION; i++) {
			expect((await submitGuess(env, { name: `Guesser ${String.fromCharCode(65 + i)}`, guessAt: guessAt(i), source: 'web', ipHash: 'cafe' })).ok).toBe(true);
		}
		const over = await submitGuess(env, { name: 'Late Arrival', guessAt: guessAt(50), source: 'web', ipHash: 'cafe' });
		expect(over).toMatchObject({ ok: false, code: 'limit' });
		expect(!over.ok && over.error).toMatch(/connection/);
	});

	it('caps email at 3 per sender, whatever the names', async () => {
		const env = sqliteEnv();
		for (const [i, name] of ['A', 'B', 'C'].entries()) {
			expect((await submitGuess(env, { name: `Emailer ${name}`, guessAt: guessAt(i), source: 'email', ipHash: 'sender' })).ok).toBe(true);
		}
		const fourth = await submitGuess(env, { name: 'Emailer D', guessAt: guessAt(5), source: 'email', ipHash: 'sender' });
		expect(fourth).toMatchObject({ ok: false, code: 'limit' });
	});
});
