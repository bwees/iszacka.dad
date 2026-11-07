import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
	updateAnswerRecord: vi.fn(async () => ({ ok: true, detail: 'answer.iszacka.dad already says "is-zack-a-dad=no"' })),
	getState: vi.fn(async () => ({ status: 'no', statusChangedAt: '2026-11-01T00:00:00.000Z', dueDate: '2026-11-20' })),
}));
vi.mock('../src/notify/dns', () => ({ updateAnswerRecord: h.updateAnswerRecord }));
vi.mock('../src/lib/state', () => ({ getState: h.getState, getSetting: vi.fn(async () => null) }));
vi.mock('../src/lib/og', () => ({ renderOgImage: vi.fn(async () => ({ ok: true })) }));
vi.mock('../src/lib/updates', () => ({ createUpdate: vi.fn() }));
vi.mock('../src/routes/resend-webhook', () => ({ purgeResendEvents: vi.fn(async () => 0) }));

const { handleScheduled } = await import('../src/cron');

function env(): Env {
	const now = new Date().toISOString();
	return {
		DB: {
			// lastDailyDate: today's post already exists, so the daily post is skipped.
			prepare: () => ({ first: async () => ({ created_at: now }), bind: () => ({ first: async () => null }) }),
			batch: async () => [{ meta: { changes: 0 } }, { meta: { changes: 0 } }],
		},
	} as unknown as Env;
}

describe('daily cron', () => {
	it('re-syncs the DNS answer record every day, even when the daily post is skipped', async () => {
		await handleScheduled({ scheduledTime: Date.now() } as ScheduledController, env(), {} as ExecutionContext);
		expect(h.updateAnswerRecord).toHaveBeenCalledTimes(1);
		expect(h.getState).toHaveBeenCalledWith(expect.anything(), { fresh: true });
	});

	it('reports a failed DNS sync as a failed run', async () => {
		h.updateAnswerRecord.mockResolvedValueOnce({ ok: false, detail: 'Cloudflare API timed out' });
		await expect(handleScheduled({ scheduledTime: Date.now() } as ScheduledController, env(), {} as ExecutionContext)).rejects.toThrow(
			/1 task/,
		);
	});
});

describe('.dev.vars.example', () => {
	it('never points local dev at the public answer record', () => {
		const example = readFileSync(join(__dirname, '..', '.dev.vars.example'), 'utf8');
		const name = /^DNS_RECORD_NAME=(.*)$/m.exec(example)?.[1]?.trim();
		expect(name).toBeTruthy();
		expect(name).not.toBe('answer.iszacka.dad');
	});
});
