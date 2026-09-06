-- Veridict schema. Portable subset that runs on both SQLite and Postgres.
-- TEXT ids (uuid strings) are generated in app code so both engines agree.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  institution   TEXT,
  role          TEXT NOT NULL DEFAULT 'debater',
  created_at    TEXT NOT NULL
);

-- ---------- Formats: the shape of a debate ----------
-- Nothing about a specific format is hardcoded anywhere in the app.
-- Adding WSDC or a house format is an INSERT, never a migration.

CREATE TABLE IF NOT EXISTS formats (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  short_name        TEXT NOT NULL,
  team_count        INTEGER NOT NULL,
  speakers_per_team INTEGER NOT NULL,
  uses_ranking      INTEGER NOT NULL DEFAULT 0,
  description       TEXT
);

CREATE TABLE IF NOT EXISTS format_speeches (
  id            TEXT PRIMARY KEY,
  format_id     TEXT NOT NULL REFERENCES formats(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  label         TEXT NOT NULL,
  short_label   TEXT NOT NULL,
  team_slot     INTEGER NOT NULL,
  speaker_index INTEGER NOT NULL,
  duration_sec  INTEGER NOT NULL,
  -- Window at each end where points of information are barred.
  protected_head_sec INTEGER DEFAULT 0,
  protected_tail_sec INTEGER DEFAULT 0
);

-- The judging rubric lives here as data.
CREATE TABLE IF NOT EXISTS format_criteria (
  id          TEXT PRIMARY KEY,
  format_id   TEXT NOT NULL REFERENCES formats(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  score_min   REAL NOT NULL DEFAULT 0,
  score_max   REAL NOT NULL,
  default_val REAL NOT NULL DEFAULT 0
);

-- Descriptors so judges score against an anchor, not a bare number line.
CREATE TABLE IF NOT EXISTS criterion_bands (
  id           TEXT PRIMARY KEY,
  criterion_id TEXT NOT NULL REFERENCES format_criteria(id) ON DELETE CASCADE,
  low          REAL NOT NULL,
  high         REAL NOT NULL,
  label        TEXT NOT NULL,
  descriptor   TEXT NOT NULL
);

-- ---------- Tournaments ----------

CREATE TABLE IF NOT EXISTS tournaments (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  format_id  TEXT NOT NULL REFERENCES formats(id),
  host       TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id            TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  institution   TEXT
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id       TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  speaker_index INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS rounds (
  id            TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  sequence      INTEGER NOT NULL,
  stage         TEXT NOT NULL DEFAULT 'prelim',
  motion        TEXT NOT NULL,
  info_slide    TEXT,
  room          TEXT,
  status        TEXT NOT NULL DEFAULT 'draft',
  -- Shared clock state, so a judge who reconnects lands mid-speech.
  active_speech_position INTEGER DEFAULT 1,
  speech_started_at      TEXT,
  speech_elapsed_sec     INTEGER NOT NULL DEFAULT 0,
  timer_running          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS round_teams (
  round_id  TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  team_slot INTEGER NOT NULL,
  PRIMARY KEY (round_id, team_id)
);

CREATE TABLE IF NOT EXISTS round_judges (
  round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_chair INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (round_id, user_id)
);

-- ---------- Ballots ----------

CREATE TABLE IF NOT EXISTS ballots (
  id           TEXT PRIMARY KEY,
  round_id     TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  judge_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'open',
  reasoning    TEXT,
  submitted_at TEXT
);

CREATE TABLE IF NOT EXISTS ballot_scores (
  id           TEXT PRIMARY KEY,
  ballot_id    TEXT NOT NULL REFERENCES ballots(id) ON DELETE CASCADE,
  criterion_id TEXT NOT NULL REFERENCES format_criteria(id),
  speech_position INTEGER NOT NULL,
  score        REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS ballot_rankings (
  ballot_id TEXT NOT NULL REFERENCES ballots(id) ON DELETE CASCADE,
  team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  rank      INTEGER NOT NULL,
  PRIMARY KEY (ballot_id, team_id)
);

CREATE TABLE IF NOT EXISTS speech_feedback (
  id           TEXT PRIMARY KEY,
  ballot_id    TEXT NOT NULL REFERENCES ballots(id) ON DELETE CASCADE,
  speech_position INTEGER NOT NULL,
  strengths    TEXT,
  improvements TEXT
);

CREATE INDEX IF NOT EXISTS idx_ballots_round ON ballots(round_id);
CREATE INDEX IF NOT EXISTS idx_scores_ballot ON ballot_scores(ballot_id);
CREATE INDEX IF NOT EXISTS idx_rounds_tournament ON rounds(tournament_id);
CREATE INDEX IF NOT EXISTS idx_speeches_format ON format_speeches(format_id);

-- ============================================================
-- Recording consent
-- ============================================================
-- Debate clubs are frequently mixed-age. Consent is stored per
-- speaker and checked before any audio is captured, so an
-- unconsented speaker's microphone is never opened rather than
-- being recorded and filtered later.
-- ============================================================

CREATE TABLE IF NOT EXISTS recording_consent (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- 'granted' | 'withheld' | 'pending'
  status       TEXT NOT NULL DEFAULT 'pending',
  is_minor     INTEGER NOT NULL DEFAULT 0,
  -- For under-18s, who gave it and how it was collected.
  guardian_name   TEXT,
  guardian_email  TEXT,
  collected_by    TEXT REFERENCES users(id),
  note            TEXT,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recordings (
  id            TEXT PRIMARY KEY,
  round_id      TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  speech_position INTEGER NOT NULL,
  -- Who is speaking. Null only if the slot was unassigned.
  speaker_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  recorded_by   TEXT NOT NULL REFERENCES users(id),
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL DEFAULT 'audio/webm',
  bytes         INTEGER NOT NULL,
  duration_sec  INTEGER,
  created_at    TEXT NOT NULL,
  -- Recordings are deleted after this date by `npm run prune`.
  expires_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_rec_round ON recordings(round_id);
CREATE INDEX IF NOT EXISTS idx_rec_speaker ON recordings(speaker_id);
