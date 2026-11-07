// OWNER: email agent.
// How long subscriber addresses are kept. The daily cron purges by these numbers, and the
// sign-up copy quotes them, so the promise and the purge can't drift apart.

/** Unconfirmed sign-ups are forgotten after this long. */
export const UNCONFIRMED_TTL_DAYS = 7;
/** Unsubscribed addresses are forgotten after this long (it keeps "resubscribe" working). */
export const UNSUBSCRIBED_TTL_DAYS = 30;
