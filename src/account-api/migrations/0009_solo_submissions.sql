-- Singleplayer matches waiting to be verified, and what became of them.
--
-- A solo match is played entirely in the player's browser, so its result is
-- only believed after the account API has replayed it (domain/soloVerify.ts):
-- the browser uploads the record (POST /archive_singleplayer_game), the API
-- keeps it here, and a worker replays it on the server's own engine, pays the
-- XP and drops the record. A row survives a restart (nothing is lost to a deploy
-- while a replay is queued) and is the one place that says whether a game was
-- paid, is waiting, or was refused and why.
--
-- One row per solo game (the game's own code, which is also the XP ledger's
-- reference, so a repeat submission is a no-op however it arrives). The record is
-- kept only until the submission is decided; the row (without it) is kept for a
-- while so the player's "your XP" lookup can answer, then pruned.
--
-- Forward-only: applied migrations are never edited; later changes are new files.

CREATE TABLE solo_submissions (
  game_code   text PRIMARY KEY CHECK (char_length(game_code) = 8),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- the submitted record, gzipped JSON; null once the submission is decided
  record_gz   bytea,
  status      text NOT NULL
                CHECK (status IN ('pending', 'running', 'paid', 'rejected')),
  -- why a submission was refused (a short code, never free text)
  reason      text CHECK (reason IS NULL OR char_length(reason) <= 64),
  -- replays that failed for a reason of their own (a crash, a timeout), not for
  -- what the record said
  attempts    integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);

-- the worker's queue: oldest waiting first
CREATE INDEX solo_submissions_queue_idx
  ON solo_submissions (created_at) WHERE status IN ('pending', 'running');
-- the per-account daily limit
CREATE INDEX solo_submissions_user_idx ON solo_submissions (user_id, created_at DESC);
