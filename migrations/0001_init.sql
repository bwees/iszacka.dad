-- ─────────────────────────────────────────────────────────────────────────────
-- iszacka.dad schema. No personal details about the baby are ever stored: the
-- site only knows whether Zack is a dad, when that changed, and the due date.
-- Timestamps are ISO-8601 UTC strings ("2026-11-06T21:30:00.000Z").
-- ─────────────────────────────────────────────────────────────────────────────

-- Key/value settings. Known keys:
--   status             'no' | 'soon' | 'yes'
--   status_changed_at  ISO timestamp of the last status change
--   due_date           'YYYY-MM-DD' (optional, set from /admin)
--   vapid_keys         JSON {publicKey, privateJwk} for Web Push (auto-generated)
--   ledger_keys        JSON Ed25519 key pair for the Dad Ledger (auto-generated)
--   ip_salt            random salt for hashing visitor IPs (auto-generated)
--   reload_nonce       bumped by "force every browser to reload"
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO settings (key, value) VALUES
  ('status', 'no'),
  ('status_changed_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Every status the site has ever had (drives the status page's uptime bars).
CREATE TABLE status_history (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL CHECK (status IN ('no', 'soon', 'yes')),
  at     TEXT NOT NULL
);

INSERT INTO status_history (status, at) VALUES ('no', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- The public update stream: feeds, /updates, live pushes and notifications.
--   kind     'status' (status changed) | 'daily' ("Day N: still no.") | 'system'
--   audience who gets notified: 'none' | 'daily' (daily-digest subscribers) | 'all'
CREATE TABLE updates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('status', 'daily', 'system')),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL CHECK (status IN ('no', 'soon', 'yes')),
  audience    TEXT NOT NULL DEFAULT 'none' CHECK (audience IN ('none', 'daily', 'all')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  notified_at TEXT
);

CREATE INDEX updates_created_at ON updates (created_at DESC);

-- The Dad Ledger: an append-only, hash-chained, Ed25519-signed log of status
-- changes. seq 0 is the genesis entry.
CREATE TABLE ledger (
  seq       INTEGER PRIMARY KEY,
  at        TEXT NOT NULL,
  status    TEXT NOT NULL CHECK (status IN ('no', 'soon', 'yes')),
  note      TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL,
  signature TEXT NOT NULL
);

-- Anxiety analytics: page checks, aggregated (no per-visitor rows).
CREATE TABLE checks_daily (
  day   TEXT PRIMARY KEY, -- 'YYYY-MM-DD' (Europe/London)
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE checks_hourly (
  hour  INTEGER PRIMARY KEY CHECK (hour BETWEEN 0 AND 23), -- Europe/London hour of day
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE checks_country (
  country TEXT PRIMARY KEY, -- ISO 3166-1 alpha-2, or 'XX' if unknown
  count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE checks_colo (
  colo  TEXT PRIMARY KEY, -- Cloudflare datacentre IATA code, e.g. 'LHR'
  count INTEGER NOT NULL DEFAULT 0
);

-- Email subscribers (double opt-in).
--   frequency 'big' = only real news; 'daily' = also the daily "still no" email
CREATE TABLE subscribers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  frequency       TEXT NOT NULL DEFAULT 'big' CHECK (frequency IN ('big', 'daily')),
  token           TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  confirm_sent_at TEXT,
  confirmed_at    TEXT,
  unsubscribed_at TEXT
);

-- Web Push subscriptions.
CREATE TABLE push_subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  failures    INTEGER NOT NULL DEFAULT 0,
  disabled_at TEXT
);

-- Outgoing webhooks (Discord / Slack / generic JSON).
CREATE TABLE webhooks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  url          TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL CHECK (kind IN ('discord', 'slack', 'generic')),
  frequency    TEXT NOT NULL DEFAULT 'big' CHECK (frequency IN ('big', 'daily')),
  token        TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  failures     INTEGER NOT NULL DEFAULT 0,
  last_status  INTEGER,
  last_sent_at TEXT,
  disabled_at  TEXT
);

-- Delivery log: makes the announce workflow idempotent across step retries.
--   channel   'email' | 'push' | 'webhook' | 'dns' | 'og'
--   target_id row id in the channel's table (0 for dns/og)
CREATE TABLE deliveries (
  update_id INTEGER NOT NULL,
  channel   TEXT NOT NULL CHECK (channel IN ('email', 'push', 'webhook', 'dns', 'og')),
  target_id INTEGER NOT NULL DEFAULT 0,
  ok        INTEGER NOT NULL,
  detail    TEXT,
  at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (update_id, channel, target_id)
);

-- Baby pool: guesses of when the site flips to YES.
CREATE TABLE guesses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  guess_at   TEXT NOT NULL, -- ISO UTC
  source     TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'email')),
  ip_hash    TEXT,
  hidden     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX guesses_guess_at ON guesses (guess_at);

-- Dad readiness checklist (admin-managed).
CREATE TABLE checklist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  label      TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  done_at    TEXT
);

-- Congratulations wall (opens on YES). Shown only once approved in /admin.
CREATE TABLE wall (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  message     TEXT NOT NULL,
  ip_hash     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  approved_at TEXT,
  rejected_at TEXT
);

-- Baby name suggestion box ("all suggestions will be ignored"). Approve-first.
CREATE TABLE name_suggestions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  suggested_by TEXT,
  ip_hash      TEXT,
  votes        INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  approved_at  TEXT,
  rejected_at  TEXT
);

CREATE TABLE name_votes (
  suggestion_id INTEGER NOT NULL,
  voter_hash    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (suggestion_id, voter_hash)
);

-- Inbound email counter. Sender addresses are only stored hashed.
CREATE TABLE inbound_emails (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind      TEXT NOT NULL CHECK (kind IN ('status', 'guess', 'ignored')),
  from_hash TEXT,
  at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Rendered social preview images (Browser Rendering), newest per key.
CREATE TABLE og_images (
  key        TEXT PRIMARY KEY, -- e.g. 'current'
  png        BLOB NOT NULL,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
