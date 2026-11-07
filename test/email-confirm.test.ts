import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/layout', () => ({ renderPage: vi.fn(async () => new Response('page')) }));

const { CHECK_INBOX_MESSAGE, emailSignupForm, subscribeRoutes } = await import('../src/routes/subscribe');
const { UNCONFIRMED_TTL_DAYS, UNSUBSCRIBED_TTL_DAYS } = await import('../src/lib/retention');

const TOKEN = 'tok_aaaaaaaaaaaaaaaaaaaaaaaa';

function sqliteEnv() {
	const db = new DatabaseSync(':memory:');
	db.exec(`CREATE TABLE subscribers (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, frequency TEXT NOT NULL DEFAULT 'big',
		token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, confirm_sent_at TEXT, confirmed_at TEXT, unsubscribed_at TEXT);`);
	db.prepare('INSERT INTO subscribers (email, token, created_at, confirm_sent_at) VALUES (?, ?, ?, ?)').run(
		'someone@example.com',
		TOKEN,
		'2026-11-01T00:00:00.000Z',
		'2026-11-01T00:00:00.000Z',
	);
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
					return { meta: { changes: Number(r.changes) } };
				},
				async first() {
					return db.prepare(sql).get(...(args as never[])) ?? null;
				},
			};
			return stmt;
		},
	};
	const confirmedAt = () => (db.prepare('SELECT confirmed_at FROM subscribers').get() as { confirmed_at: string | null }).confirmed_at;
	return { env: { DB: D1 } as unknown as Env, confirmedAt };
}

const json = { headers: { Accept: 'application/json' } };

describe('/confirm/:token', () => {
	it("GET never confirms (mail scanners open every link); POST does", async () => {
		const { env, confirmedAt } = sqliteEnv();
		const get = await subscribeRoutes.request(`https://iszacka.dad/confirm/${TOKEN}`, json, env);
		expect(await get.json()).toMatchObject({ ok: true, confirmed: false, state: 'pending' });
		expect(confirmedAt()).toBeNull();

		const post = await subscribeRoutes.request(`https://iszacka.dad/confirm/${TOKEN}`, { method: 'POST', ...json }, env);
		expect(await post.json()).toMatchObject({ ok: true, confirmed: true, alreadyConfirmed: false });
		expect(confirmedAt()).not.toBeNull();
		expect(post.headers.get('referrer-policy')).toBe('no-referrer');
	});
});

describe('retention copy', () => {
	it('quotes the purge, not a promise the purge does not keep', async () => {
		const form = String(await emailSignupForm({ env: {} } as never));
		expect(form).toContain(`deleted ${UNSUBSCRIBED_TTL_DAYS} days after you unsubscribe`);
		expect(form).not.toContain('deleted when you leave');
		expect(CHECK_INBOX_MESSAGE).toContain(`within ${UNCONFIRMED_TTL_DAYS} days`);
	});
});
