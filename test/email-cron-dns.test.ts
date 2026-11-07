import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const { dailyInstanceId, handleScheduled, startDaily } = await import('../src/cron');

function env(create: (opts: { id: string; params: unknown }) => Promise<unknown>) {
	const DAILY = { create: vi.fn(create) };
	return { env: { DAILY } as unknown as Env, create: DAILY.create };
}

describe('daily cron', () => {
	it("does nothing but start the day's DailyWorkflow, named after the London date", async () => {
		const { env: e, create } = env(async () => ({ id: 'x' }));
		// 23:30 UTC in summer is already the next day in London.
		const scheduledTime = Date.parse('2026-06-01T23:30:00Z');
		await handleScheduled({ scheduledTime } as ScheduledController, e, {} as ExecutionContext);
		expect(create).toHaveBeenCalledTimes(1);
		expect(create).toHaveBeenCalledWith({ id: 'daily-2026-06-02', params: { day: '2026-06-02', at: '2026-06-01T23:30:00.000Z' } });
		expect(dailyInstanceId('2026-11-07')).toBe('daily-2026-11-07');
	});

	it('treats an existing instance as "already ran today", not a failure', async () => {
		const { env: e } = env(async () => {
			throw new Error('instance.already_exists: Workflow instance already exists');
		});
		expect(await startDaily(e, new Date('2026-11-07T09:00:00Z'))).toEqual({ alreadyRan: 'daily-2026-11-07' });
		await expect(handleScheduled({ scheduledTime: Date.parse('2026-11-07T09:00:00Z') } as ScheduledController, e, {} as ExecutionContext)).resolves.toBeUndefined();
	});

	it('fails the invocation when the workflow cannot be started', async () => {
		const { env: e } = env(async () => {
			throw new Error('Workflows is having a moment');
		});
		await expect(handleScheduled({ scheduledTime: Date.now() } as ScheduledController, e, {} as ExecutionContext)).rejects.toThrow(/having a moment/);
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
