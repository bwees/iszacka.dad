// A D1 stand-in over node:sqlite with the repo's real migrations, for end-to-end tests of the
// notification pipeline. It counts round trips (a db.batch is one) the way D1 bills them.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

interface Statement {
	bind(...args: unknown[]): Statement;
	first<T>(): Promise<T | null>;
	all<T>(): Promise<{ results: T[]; success: true; meta: { changes: number } }>;
	run(): Promise<{ success: true; results: unknown[]; meta: { changes: number } }>;
	exec(): { success: true; results: unknown[]; meta: { changes: number } };
}

export function sqliteD1() {
	const db = new DatabaseSync(':memory:');
	const dir = join(__dirname, '..', 'migrations');
	for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, file), 'utf8'));
	const counts = { roundTrips: 0 };

	const exec = (sql: string, args: unknown[]) => {
		const stmt = db.prepare(sql);
		if (/^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
			const rows = stmt.all(...(args as never[]));
			return { success: true as const, results: rows as unknown[], meta: { changes: rows.length } };
		}
		const r = stmt.run(...(args as never[]));
		return { success: true as const, results: [] as unknown[], meta: { changes: Number(r.changes) } };
	};

	const prepare = (sql: string, args: unknown[] = []): Statement => ({
		// D1's bind returns a new statement; so does this.
		bind: (...next: unknown[]) => prepare(sql, next),
		async first<T>() {
			counts.roundTrips++;
			return (exec(sql, args).results[0] as T | undefined) ?? null;
		},
		async all<T>() {
			counts.roundTrips++;
			const r = exec(sql, args);
			return { results: r.results as T[], success: true as const, meta: r.meta };
		},
		async run() {
			counts.roundTrips++;
			return exec(sql, args);
		},
		exec: () => exec(sql, args),
	});

	const D1 = {
		prepare: (sql: string) => prepare(sql),
		async batch(statements: Statement[]) {
			counts.roundTrips++;
			db.exec('BEGIN');
			try {
				const out = statements.map((s) => s.exec());
				db.exec('COMMIT');
				return out;
			} catch (err) {
				db.exec('ROLLBACK');
				throw err;
			}
		},
	};
	return { D1: D1 as unknown as D1Database, db, counts };
}
