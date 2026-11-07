// Shared by the inbound email tests: just enough D1 over node:sqlite (with the real migrations)
// to run the inbound SQL for real, batches included, plus a WorkflowStep that runs callbacks
// inline and retries like the engine.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';

const MIGRATIONS = join(import.meta.dirname, '..', 'migrations');

type Row = Record<string, unknown>;

export interface SqliteD1 {
	db: DatabaseSync;
	D1: D1Database;
	/** Every statement run, in order (batches included). */
	log: string[];
	/** Make the next `n` batches throw (a D1 outage). */
	failBatches(n: number): void;
	rows(sql: string, ...args: unknown[]): Row[];
}

/** An in-memory database with every migration applied. */
export function sqliteD1(): SqliteD1 {
	const db = new DatabaseSync(':memory:');
	for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
		db.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
	}
	const log: string[] = [];
	let failingBatches = 0;

	const isRead = (sql: string) => /^\s*(?:SELECT|WITH)\b/i.test(sql);
	const exec = (sql: string, args: unknown[]) => {
		log.push(sql.replace(/\s+/g, ' ').trim());
		const stmt = db.prepare(sql);
		if (isRead(sql)) return { results: stmt.all(...(args as never[])) as Row[], success: true, meta: { changes: 0 } };
		const r = stmt.run(...(args as never[]));
		return { results: [] as Row[], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
	};

	const prepare = (sql: string) => {
		let args: unknown[] = [];
		const stmt = {
			sql,
			get args() {
				return args;
			},
			bind(...values: unknown[]) {
				args = values;
				return stmt;
			},
			async run() {
				return exec(sql, args);
			},
			async all() {
				return exec(sql, args);
			},
			async first(column?: string) {
				const row = (exec(sql, args).results[0] ?? null) as Row | null;
				return column && row ? (row[column] ?? null) : row;
			},
		};
		return stmt;
	};

	const D1 = {
		prepare,
		async batch(statements: Array<ReturnType<typeof prepare>>) {
			if (failingBatches > 0) {
				failingBatches--;
				throw new Error('D1_ERROR: simulated outage');
			}
			db.exec('BEGIN');
			try {
				const out = statements.map((s) => exec(s.sql, s.args));
				db.exec('COMMIT');
				return out;
			} catch (err) {
				db.exec('ROLLBACK');
				throw err;
			}
		},
	} as unknown as D1Database;

	return {
		db,
		D1,
		log,
		failBatches(n: number) {
			failingBatches = n;
		},
		rows: (sql, ...args) => db.prepare(sql).all(...(args as never[])) as Row[],
	};
}

export interface FakeStep {
	step: WorkflowStep;
	/** Step names in the order they finished (or gave up). */
	names: string[];
	/** Attempts per step name. */
	attempts: Map<string, number>;
	/** Run this step's callback twice, as if its first result had been lost before it was saved. */
	repeat: Set<string>;
}

/**
 * A WorkflowStep that runs callbacks inline: `retries.limit` retries after the first attempt
 * (no delays), attempts counted from 1. A finished step's result is cached by name, so running
 * the same workflow again with the same FakeStep replays it, like the engine.
 */
export function fakeStep(): FakeStep {
	const names: string[] = [];
	const attempts = new Map<string, number>();
	const cache = new Map<string, unknown>();
	const repeat = new Set<string>();
	const step = {
		async do(name: string, configOrFn: unknown, maybeFn?: unknown) {
			if (cache.has(name)) return structuredClone(cache.get(name));
			const config = (typeof configOrFn === 'function' ? {} : configOrFn) as WorkflowStepConfig;
			const fn = (typeof configOrFn === 'function' ? configOrFn : maybeFn) as (ctx: { attempt: number }) => Promise<unknown>;
			const limit = config.retries?.limit ?? 5;
			let lastError: unknown;
			for (let attempt = 1; attempt <= limit + 1; attempt++) {
				attempts.set(name, attempt);
				try {
					if (repeat.has(name)) {
						repeat.delete(name);
						await fn({ attempt });
					}
					// Step results go through serialisation in the real engine.
					const result = structuredClone(await fn({ attempt }));
					cache.set(name, result);
					names.push(name);
					return structuredClone(result);
				} catch (err) {
					lastError = err;
				}
			}
			names.push(name);
			throw lastError;
		},
		async sleep() {},
		async sleepUntil() {},
	};
	return { step: step as unknown as WorkflowStep, names, attempts, repeat };
}
