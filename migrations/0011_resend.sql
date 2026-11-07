-- ─────────────────────────────────────────────────────────────────────────────
-- Resend webhook deliveries already handled, keyed by the svix-id header.
--
-- Resend (via Svix) retries a delivery until it gets a 2xx, and may deliver the
-- same event more than once. POST /api/resend/webhook inserts the svix-id after
-- checking the signature and only processes the event if the insert added a
-- row, so a retry can never send a second auto-reply or enter a guess twice.
-- The daily cron forgets rows older than 30 days (Svix stops retrying long
-- before that).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE resend_events (
  svix_id TEXT PRIMARY KEY,
  type    TEXT NOT NULL,
  at      TEXT NOT NULL -- ISO UTC, when we first saw it
);

CREATE INDEX resend_events_at ON resend_events (at);
