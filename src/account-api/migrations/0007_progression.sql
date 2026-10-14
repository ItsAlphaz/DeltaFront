-- Progression: XP, levels, prestige, seasons, challenges and clan XP.
--
-- Canonical state is small: user_progress holds lifetime XP, the XP of the
-- current prestige run and the prestige count. Level and rank are DERIVED
-- (packages/shared/src/ProgressionRules.ts) and never stored. Every change to
-- XP is an append-only xp_ledger row, unique per (user, source, reference) for
-- game and challenge awards, so a game or a challenge can never pay twice.
--
-- Nothing is rewritten and nothing is backfilled: games ingested before this
-- migration keep xp_result NULL and are reported as played before levels
-- existed. The tables are inert while the `progression` feature is off.
--
-- Applied migrations are never edited; later changes are new files.

-- ---------------------------------------------------------------------------
-- Seasons (created by the owner; archived ones stay readable forever)
-- ---------------------------------------------------------------------------

CREATE TABLE seasons (
  id            bigserial PRIMARY KEY,
  number        integer NOT NULL UNIQUE CHECK (number > 0),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  -- the season's own cosmetic on the free track: {"40": "flag:name"}
  reward_flares jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- set by the closing job once the season is over and final ranks are stored
  archived_at   timestamptz,
  CHECK (ends_at > starts_at)
);
CREATE INDEX seasons_window_idx ON seasons (starts_at, ends_at);

-- ---------------------------------------------------------------------------
-- XP
-- ---------------------------------------------------------------------------

CREATE TABLE user_progress (
  user_id      uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  -- never reset; the whole history of XP
  lifetime_xp  bigint NOT NULL DEFAULT 0 CHECK (lifetime_xp >= 0),
  -- XP of the current prestige run (0 to the level-100 total); resets on prestige
  run_xp       bigint NOT NULL DEFAULT 0 CHECK (run_xp >= 0),
  prestige     smallint NOT NULL DEFAULT 0 CHECK (prestige BETWEEN 0 AND 10),
  -- the title the player chose to show (checked against what they earned when read)
  display_title text CHECK (char_length(display_title) <= 40),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (lifetime_xp >= run_xp)
);
CREATE INDEX user_progress_lifetime_idx ON user_progress (lifetime_xp DESC, user_id);

-- Append-only: rows are only ever inserted.
CREATE TABLE xp_ledger (
  id             bigserial PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- the change to lifetime XP; negative only for an admin revoke or set
  delta          bigint NOT NULL CHECK (delta <> 0),
  lifetime_after bigint NOT NULL CHECK (lifetime_after >= 0),
  run_after      bigint NOT NULL CHECK (run_after >= 0),
  prestige       smallint NOT NULL,
  source         text NOT NULL
                   CHECK (source IN ('match', 'daily_challenge', 'weekly_challenge',
                                     'admin_grant', 'admin_revoke', 'admin_set')),
  -- match: the game code; challenges: <period key>:<challenge id>; admin: the audit id
  ref_type       text,
  ref_id         text,
  season_id      bigint REFERENCES seasons (id) ON DELETE SET NULL,
  season_delta   bigint NOT NULL DEFAULT 0,
  -- UTC day the award counts towards
  reward_day     date,
  actor          uuid REFERENCES users (id) ON DELETE SET NULL,
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX xp_ledger_user_created_idx ON xp_ledger (user_id, created_at DESC, id DESC);
-- the same game or challenge can never pay the same player twice
CREATE UNIQUE INDEX xp_ledger_award_once
  ON xp_ledger (user_id, source, ref_id)
  WHERE source IN ('match', 'daily_challenge', 'weekly_challenge');

-- The UTC day's match XP (for the soft cap) and which game used each daily bonus.
CREATE TABLE xp_daily (
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  day            date NOT NULL,
  match_xp       bigint NOT NULL DEFAULT 0 CHECK (match_xp >= 0),
  first_game_ref text,
  first_win_ref  text,
  PRIMARY KEY (user_id, day)
);

-- One row per prestige. The two unique keys make a double prestige impossible:
-- the same request (key) answers with the stored response, and a rank can be
-- entered only once.
CREATE TABLE prestige_events (
  id              bigserial PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 100),
  from_prestige   smallint NOT NULL,
  to_prestige     smallint NOT NULL,
  run_xp_before   bigint NOT NULL,
  lifetime_xp     bigint NOT NULL,
  response        jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  UNIQUE (user_id, to_prestige)
);

-- ---------------------------------------------------------------------------
-- Seasons: per-player progress (doubles as the archive) and rewards
-- ---------------------------------------------------------------------------

CREATE TABLE user_season_progress (
  season_id   bigint NOT NULL REFERENCES seasons (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  xp          bigint NOT NULL DEFAULT 0 CHECK (xp >= 0),
  -- written when the season is archived
  final_level smallint,
  final_rank  integer,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (season_id, user_id)
);
CREATE INDEX user_season_progress_rank_idx
  ON user_season_progress (season_id, xp DESC, updated_at, user_id);
CREATE INDEX user_season_progress_user_idx ON user_season_progress (user_id);

-- Rewards the player earned by progressing: Credits (claimed through the rewards
-- UI) and, with them, a cosmetic that is granted at once. `key` makes each
-- reward unique per account: level:p<prestige>:<level>, prestige:<n>,
-- season:<season id>:level:<level>, challenge:<period key>:<challenge id>.
CREATE TABLE progression_rewards (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key         text NOT NULL,
  kind        text NOT NULL
                CHECK (kind IN ('level_milestone', 'prestige', 'season_track', 'challenge')),
  credits     bigint NOT NULL DEFAULT 0 CHECK (credits >= 0),
  flare       text,
  season_id   bigint REFERENCES seasons (id) ON DELETE SET NULL,
  unlocked_at timestamptz NOT NULL DEFAULT now(),
  -- NULL = waiting to be claimed; a reward with no Credits is claimed on creation
  claimed_at  timestamptz,
  UNIQUE (user_id, key)
);
CREATE INDEX progression_rewards_unclaimed_idx
  ON progression_rewards (user_id) WHERE claimed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Challenges: assigned deterministically in code, so a row exists only once
-- there is progress to record.
-- ---------------------------------------------------------------------------

CREATE TABLE challenge_progress (
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- d:YYYY-MM-DD or w:YYYY-Www (UTC)
  period_key   text NOT NULL,
  challenge_id text NOT NULL,
  progress     bigint NOT NULL DEFAULT 0 CHECK (progress >= 0),
  target       bigint NOT NULL CHECK (target > 0),
  completed_at timestamptz,
  reward_xp    integer NOT NULL DEFAULT 0 CHECK (reward_xp >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, period_key, challenge_id)
);

-- ---------------------------------------------------------------------------
-- What each game awarded each player
-- ---------------------------------------------------------------------------

-- xp_result is NULL for games ingested before progression existed (or while the
-- feature is off). Otherwise it is {"eligible": false, "reason": ...} or the
-- breakdown, the before/after position, the levels crossed, the challenges
-- completed and the review flags.
ALTER TABLE game_players
  ADD COLUMN xp_awarded bigint NOT NULL DEFAULT 0 CHECK (xp_awarded >= 0),
  ADD COLUMN clan_xp    bigint NOT NULL DEFAULT 0 CHECK (clan_xp >= 0),
  ADD COLUMN xp_result  jsonb;
CREATE INDEX game_players_clan_xp_idx ON game_players (clan_id) WHERE clan_xp > 0;

-- ---------------------------------------------------------------------------
-- Existing allowed-value checks that progression extends. As in 0005 and 0006
-- the old checks are found by their definition, not by an auto-generated name.
-- ---------------------------------------------------------------------------

-- currency_ledger.reason gains 'progression_reward' (a claimed progression reward).
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'currency_ledger'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%refund%'
  LOOP
    EXECUTE format('ALTER TABLE currency_ledger DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE currency_ledger ADD CONSTRAINT currency_ledger_reason_check
  CHECK (reason IN ('purchase', 'game_reward', 'admin_grant', 'admin_revoke',
                    'refund', 'progression_reward'));

-- a progression reward can never pay twice
CREATE UNIQUE INDEX currency_ledger_progression_reward_once
  ON currency_ledger (user_id, ref_type, ref_id) WHERE reason = 'progression_reward';

-- user_flares.source gains 'reward' (a cosmetic unlocked by progressing).
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'user_flares'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%purchase%'
       AND pg_get_constraintdef(oid) LIKE '%admin%'
  LOOP
    EXECUTE format('ALTER TABLE user_flares DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE user_flares ADD CONSTRAINT user_flares_source_check
  CHECK (source IN ('purchase', 'admin', 'reward'));
