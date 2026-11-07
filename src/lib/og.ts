// OWNER: ledger agent.
// The social preview image. Nothing is rendered at request time: the three cards
// in public/og/{no,soon,yes}.png are pre-rendered from lib/og-card.ts by
// scripts/og-render.ts and committed. /og.png (routes/ledger.ts) serves the one
// for the status straight from the ASSETS binding, with no D1 read, so it fits the
// Workers Free 10 ms CPU budget easily.

import { isStatus, type Status } from '../types';

/** Path of the pre-rendered card for `status` in the ASSETS binding (public/og/). */
export function ogCardPath(status: Status): string {
	return `/og/${status}.png`;
}

/**
 * The status named by an og:image version (`?v=<status>-<ms>`, see ogImageUrl in
 * lib/layout.ts), or null if `v` isn't one. A versioned URL always maps to the same
 * card, so it can be cached forever, even by an isolate whose state lags behind.
 */
export function ogVersionStatus(v: string | null | undefined): Status | null {
	const match = /^([a-z]+)-\d{1,16}$/.exec(v ?? '');
	const status = match?.[1];
	return status && isStatus(status) ? status : null;
}
