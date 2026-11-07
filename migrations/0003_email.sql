-- ─────────────────────────────────────────────────────────────────────────────
-- Email agent: the Resend daily-send quota ledger.
--
-- Resend's free plan allows 100 emails/day; the Worker keeps its own count
-- (EMAIL_DAILY_LIMIT, default 90) so it can stop before Resend does, let an
-- announcement sleep until the UTC midnight reset, and keep a reserve so the
-- daily "still no" never crowds out real news. Best-effort: a missing or
-- broken table must never break a send.
-- ─────────────────────────────────────────────────────────────────────────────

-- Successful sends per UTC day ('YYYY-MM-DD').
CREATE TABLE email_sends (
  day TEXT PRIMARY KEY,
  n   INTEGER NOT NULL DEFAULT 0
);
