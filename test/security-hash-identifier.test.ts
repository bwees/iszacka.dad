import { describe, expect, it } from 'vitest';
import { hashIdentifier } from '../src/lib/security';

/** A settings table with one row, counting reads. */
function fakeDb(salt: string) {
	const db = {
		reads: 0,
		prepare: (sql: string) => ({
			bind: () => ({
				first: async () => {
					if (/SELECT/i.test(sql)) db.reads++;
					return { value: salt };
				},
				run: async () => ({}),
			}),
		}),
	};
	return db;
}

describe('hashIdentifier', () => {
	it('reads the salt once per isolate, then hashes without D1', async () => {
		const db = fakeDb('salt-a');
		const env = { DB: db } as unknown as Env;
		const first = await hashIdentifier(env, '192.0.2.1');
		const second = await hashIdentifier(env, '192.0.2.1');
		expect(second).toBe(first);
		expect(first).toMatch(/^[0-9a-f]{32}$/);
		expect(db.reads).toBe(1);
	});

	it('keeps each database to its own salt', async () => {
		const a = await hashIdentifier({ DB: fakeDb('salt-1') } as unknown as Env, '192.0.2.1');
		const b = await hashIdentifier({ DB: fakeDb('salt-2') } as unknown as Env, '192.0.2.1');
		expect(a).not.toBe(b);
	});
});
