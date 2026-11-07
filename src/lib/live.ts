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
