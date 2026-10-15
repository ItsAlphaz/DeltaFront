-- XP secured at a death, before the game is stored.
--
-- A player who is eliminated is paid their reduced award (lifetime XP only) as
-- soon as the game server reports the elimination, not when the whole match
-- ends. The payment is an ordinary xp_ledger row (unique per user and game, so
-- it can never be paid twice); this table keeps what the player was told about
-- it (the breakdown, the level before and after, the levels crossed) so that:
--   * the player can read it at once (GET /users/@me/xp/:gameId), and
--   * the stored game, when it arrives, adopts this award for the player's
--     game_players row instead of working one out and paying again.
--
-- Rows are small, one per eliminated account player and game, and are never
-- edited. Nothing is rewritten or backfilled. Applied migrations are never
-- edited; later changes are new files.

CREATE TABLE early_xp (
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- the game's code (the game is not stored yet, so there is no games row to point at)
  game_code  text NOT NULL CHECK (char_length(game_code) BETWEEN 1 AND 64),
  xp_awarded bigint NOT NULL CHECK (xp_awarded >= 0),
  -- the same shape as game_players.xp_result for an eligible player
  result     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, game_code)
);
