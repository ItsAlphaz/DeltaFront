-- DeltaFront account API, milestone M3: the basic player leaderboard.
-- docs/DeltaFrontAccountsPlan.md sections 6.3 and 11.2.
--
-- leaderboard_players is a derived table: jobs/leaderboard.ts rebuilds it from
-- game_players and games (counted games only) every few minutes, each period in
-- one transaction, so readers see the old snapshot until the new one commits.
-- Nothing else writes it and no request input ever reaches it. Names are not
-- copied here: a page joins users, so a rename (or a ban or deletion) shows at
-- once.
--
-- Applied migrations are never edited; later changes are new files.

CREATE TABLE leaderboard_players (
  period     text NOT NULL CHECK (period IN ('all', '30d')),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- the position in the full order (wins, win rate, games, public id): one row
  -- per position, so a page is a plain range
  rank_pos   integer NOT NULL CHECK (rank_pos >= 1),
  -- the displayed rank: competition ranking (1, 2, 2, 4) on (wins, win rate)
  rank       integer NOT NULL CHECK (rank >= 1),
  games      integer NOT NULL CHECK (games >= 0),
  wins       integer NOT NULL CHECK (wins >= 0),
  losses     integer NOT NULL CHECK (losses >= 0),
  win_rate   numeric NOT NULL CHECK (win_rate >= 0 AND win_rate <= 1),
  built_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (period, user_id)
);

CREATE UNIQUE INDEX leaderboard_players_position_idx
  ON leaderboard_players (period, rank_pos);
