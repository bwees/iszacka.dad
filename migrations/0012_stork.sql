-- ─────────────────────────────────────────────────────────────────────────────
-- Catch the Stork (/stork): the high-score table.
--
-- A score is three initials (A-Z) and a number, which are public on the
-- leaderboard, plus the salted hash of the submitter's connection (IPv6 /64),
-- which is not: it only enforces the five-scores-a-day cap. `game` is the nonce
-- of the server-issued game token, so one game can only be submitted once.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE stork_scores (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  initials   TEXT NOT NULL CHECK (length(initials) = 3 AND initials GLOB '[A-Z][A-Z][A-Z]'),
  score      INTEGER NOT NULL CHECK (score >= 0),
  ip_hash    TEXT,
  game       TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The leaderboard: highest first, earliest first on a tie.
CREATE INDEX stork_scores_top ON stork_scores (score DESC, id ASC);

-- The daily cap: today's scores from one connection.
CREATE INDEX stork_scores_ip ON stork_scores (ip_hash, created_at);
