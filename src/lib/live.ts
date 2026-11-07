// Fan-out to every open browser via the single global WaitingRoom Durable Object.

import type { LiveMessage } from '../types';

export const WAITING_ROOM_NAME = 'global';

export function waitingRoom(env: Env) {
	return env.WAITING_ROOM.get(env.WAITING_ROOM.idFromName(WAITING_ROOM_NAME));
}

/** Push a message to every connected WebSocket / SSE client. Never throws. */
export async function broadcast(env: Env, msg: LiveMessage): Promise<void> {
	try {
		await waitingRoom(env).broadcast(msg);
	} catch (err) {
		console.error('live broadcast failed:', err);
	}
}

/** Current live numbers, or zeros if the Durable Object is unavailable. */
export async function liveStats(env: Env): Promise<{ viewers: number; vibes: number }> {
	try {
		return await waitingRoom(env).stats();
	} catch (err) {
		console.error('live stats failed:', err);
		return { viewers: 0, vibes: 0 };
	}
}

export interface LiveSnapshot {
	viewers: number;
	vibes: number;
	/** The running check total; missing when the Durable Object is unavailable. */
	checks?: number;
	/** The current reload nonce; missing (never empty) when the Durable Object is unavailable. */
	reloadNonce?: string;
}

/**
 * Viewers, vibes, the check total and the reload nonce in one RPC (one DO request instead of
 * `liveStats` plus `getCheckTotal`). Zeros and no `checks`/`reloadNonce` if the Durable Object
 * is unavailable: callers fall back to `getCheckTotal`, which asks D1. Never throws.
 */
export async function liveSnapshot(env: Env): Promise<LiveSnapshot> {
	try {
		return await waitingRoom(env).liveSnapshot();
	} catch (err) {
		console.error('live snapshot failed:', err);
		return { viewers: 0, vibes: 0 };
	}
}
