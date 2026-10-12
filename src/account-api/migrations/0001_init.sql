-- DeltaFront account API: initial schema.
-- docs/DeltaFrontAccountsPlan.md section 6 (and owner decisions D1-D3).
--
-- Conventions: timestamps are timestamptz, money is bigint, case-insensitive
-- names are citext. users.id is the persistent ID (the JWT `sub`, base64url
-- encoded); public_id is the separate, shareable one.
--
-- Deliberately not here:
--   magic_link_tokens   milestone M8 (email sign-in is not in V1; decision D3)
--   leaderboard_players milestone M3 (a derived table; its shape is decided there)
-- Items are not a table either: they live in the catalog file (plan 9.3).
--
-- Applied migrations are never edited; later changes are new files.

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- Identity and sessions
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id               text NOT NULL UNIQUE
                            CHECK (public_id ~ '^[A-Za-z0-9]{6,32}$'),
  -- registered = has at least one linked identity
  kind                    text NOT NULL CHECK (kind IN ('guest', 'registered')),
  -- 'banned' is derived from bans, never stored here
  role                    text CHECK (role IN ('root', 'admin', 'mod', 'flagged')),
  username_base           citext,
  username_discriminator  char(4) CHECK (username_discriminator ~ '^[0-9]{4}$'),
  next_username_change_at timestamptz,
  level_hidden            boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now(),
  last_seen_at            timestamptz NOT NULL DEFAULT now(),
  -- deletion runs 24 hours after it is requested
  deletion_requested_at   timestamptz,
  deleted_at              timestamptz,
  CHECK ((username_base IS NULL) = (username_discriminator IS NULL))
);
CREATE UNIQUE INDEX users_username_unique
  ON users (username_base, username_discriminator)
  WHERE username_base IS NOT NULL;
CREATE INDEX users_kind_last_seen_idx ON users (kind, last_seen_at);
CREATE INDEX users_created_at_idx ON users (created_at);

CREATE TABLE auth_identities (
  id               bigserial PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider         text NOT NULL
                     CHECK (provider IN ('discord', 'google', 'email', 'steam')),
  -- Discord id, Google sub, lower-cased email, or SteamID64
  provider_user_id text NOT NULL,
  email            citext,
  email_verified   boolean NOT NULL DEFAULT false,
  display_name     text,
  avatar           text,
  -- provider profile as returned (e.g. Discord username, global_name, discriminator)
  profile          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_login_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id),
  -- one identity of each kind per account
  UNIQUE (user_id, provider)
);
CREATE INDEX auth_identities_email_idx ON auth_identities (email);

CREATE TABLE refresh_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- every token rotated from the same sign-in shares a family, so a stolen
  -- token being replayed can revoke the whole chain
  family_id      uuid NOT NULL,
  -- SHA-256 of the opaque token; the token itself is never stored
  token_hash     bytea NOT NULL UNIQUE,
  parent_id      uuid REFERENCES refresh_sessions (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text,
  user_agent     text,
  ip_hash        bytea
);
CREATE INDEX refresh_sessions_user_active_idx
  ON refresh_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX refresh_sessions_family_idx ON refresh_sessions (family_id);

CREATE TABLE oauth_states (
  state         text PRIMARY KEY,
  provider      text NOT NULL CHECK (provider IN ('discord', 'google', 'steam')),
  redirect_uri  text NOT NULL,
  pkce_verifier text NOT NULL,
  -- set when a signed-in user is linking a provider rather than signing in
  link_user_id  uuid REFERENCES users (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX oauth_states_expires_idx ON oauth_states (expires_at);

CREATE TABLE bans (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  category   text NOT NULL,
  -- shown to the banned player
  reason     text,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX bans_user_active_idx ON bans (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Economy and inventory (one currency: Credits, decision D1)
-- ---------------------------------------------------------------------------

CREATE TABLE wallets (
  user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  credits    bigint NOT NULL DEFAULT 0 CHECK (credits >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only: rows are only ever inserted.
CREATE TABLE currency_ledger (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- kept as a column so the ledger format survives a future second currency
  currency      text NOT NULL DEFAULT 'credits' CHECK (currency IN ('credits')),
  delta         bigint NOT NULL CHECK (delta <> 0),
  balance_after bigint NOT NULL CHECK (balance_after >= 0),
  reason        text NOT NULL
                  CHECK (reason IN ('purchase', 'game_reward', 'admin_grant',
                                    'admin_revoke', 'refund')),
  ref_type      text,
  ref_id        text,
  -- the admin who made the change, when there was one
  actor         uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- UTC day a gameplay reward counts towards (the daily cap)
  reward_day    date,
  CHECK (reason <> 'game_reward'
         OR (reward_day IS NOT NULL AND ref_type IS NOT NULL AND ref_id IS NOT NULL))
);
CREATE INDEX currency_ledger_user_created_idx
  ON currency_ledger (user_id, created_at DESC);
CREATE INDEX currency_ledger_reward_day_idx
  ON currency_ledger (user_id, reward_day) WHERE reason = 'game_reward';
-- the same game can never pay the same player twice
CREATE UNIQUE INDEX currency_ledger_game_reward_once
  ON currency_ledger (user_id, ref_type, ref_id) WHERE reason = 'game_reward';

CREATE TABLE purchases (
  id              bigserial PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- 'pack' is added later, together with bundles
  kind            text NOT NULL CHECK (kind IN ('cosmetic')),
  item_key        text NOT NULL,
  flares          text[] NOT NULL,
  price_credits   bigint NOT NULL CHECK (price_credits >= 0),
  -- hash of the catalog file the price came from
  catalog_version text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchases_user_created_idx ON purchases (user_id, created_at DESC);

-- Ownership. Free default items are not stored: they come from the catalog.
CREATE TABLE user_flares (
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- pattern:<name>[:<palette>], flag:<name>, effect:<name>, ...
  flare       text NOT NULL,
  source      text NOT NULL CHECK (source IN ('purchase', 'admin')),
  purchase_id bigint REFERENCES purchases (id) ON DELETE SET NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  PRIMARY KEY (user_id, flare)
);
CREATE INDEX user_flares_flare_idx ON user_flares (flare);

-- ---------------------------------------------------------------------------
-- Clans (decision D2: one clan at a time, enforced here)
-- ---------------------------------------------------------------------------

CREATE TABLE clans (
  id               bigserial PRIMARY KEY,
  -- stored upper-case; matching is case-insensitive
  tag              citext NOT NULL
                     CHECK (tag::text ~ '^[A-Z0-9]{2,5}$'),
  name             citext NOT NULL CHECK (char_length(name::text) BETWEEN 1 AND 35),
  description      text NOT NULL DEFAULT '' CHECK (char_length(description) <= 200),
  discord_url      text CHECK (char_length(discord_url) <= 255),
  is_open          boolean NOT NULL DEFAULT true,
  created_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  disbanded_at     timestamptz,
  removed_by_admin boolean NOT NULL DEFAULT false
);
-- a tag or name is unique among live clans; a disbanded clan frees both
-- (the tag is held separately, see clan_tag_holds)
CREATE UNIQUE INDEX clans_tag_live ON clans (tag) WHERE disbanded_at IS NULL;
CREATE UNIQUE INDEX clans_name_live ON clans (name) WHERE disbanded_at IS NULL;

CREATE TABLE clan_members (
  clan_id   bigint NOT NULL REFERENCES clans (id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role      text NOT NULL CHECK (role IN ('leader', 'officer', 'member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clan_id, user_id),
  -- one clan at a time: membership, and therefore ownership
  UNIQUE (user_id)
);
-- exactly one leader per clan
CREATE UNIQUE INDEX clan_members_one_leader
  ON clan_members (clan_id) WHERE role = 'leader';

-- Pending requests only: a row is deleted when it is decided or withdrawn.
CREATE TABLE clan_join_requests (
  clan_id    bigint NOT NULL REFERENCES clans (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clan_id, user_id)
);
CREATE INDEX clan_join_requests_user_idx ON clan_join_requests (user_id);

CREATE TABLE clan_bans (
  clan_id    bigint NOT NULL REFERENCES clans (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  banned_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clan_id, user_id)
);

-- A disbanded clan's tag stays unavailable for a while so it cannot be used to
-- impersonate the old clan in replays and history.
CREATE TABLE clan_tag_holds (
  tag            citext PRIMARY KEY,
  released_at    timestamptz NOT NULL DEFAULT now(),
  reusable_after timestamptz NOT NULL
);

CREATE TABLE clan_events (
  id         bigserial PRIMARY KEY,
  clan_id    bigint NOT NULL REFERENCES clans (id) ON DELETE CASCADE,
  actor      uuid REFERENCES users (id) ON DELETE SET NULL,
  action     text NOT NULL,
  target     uuid REFERENCES users (id) ON DELETE SET NULL,
  details    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clan_events_clan_created_idx ON clan_events (clan_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Games and stats
-- ---------------------------------------------------------------------------

CREATE TABLE games (
  id               bigserial PRIMARY KEY,
  -- the client-generated game ID
  game_code        varchar(10) NOT NULL UNIQUE,
  source           text NOT NULL CHECK (source IN ('server', 'singleplayer')),
  type             text NOT NULL CHECK (type IN ('Public', 'Private', 'Singleplayer')),
  mode             text,
  difficulty       text,
  map              text,
  player_teams     text,
  ranked_type      text,
  public_game_type text,
  started_at       timestamptz NOT NULL,
  ended_at         timestamptz NOT NULL,
  duration_s       integer NOT NULL CHECK (duration_s >= 0),
  human_players    integer NOT NULL CHECK (human_players >= 0),
  winner           jsonb,
  git_commit       text,
  server_letter    char(1) CHECK (server_letter ~ '^[a-z]$'),
  -- whether the game feeds leaderboards, Credits and the clan threshold
  counts_for_stats boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX games_started_at_idx ON games (started_at DESC);

CREATE TABLE game_records (
  game_id    bigint PRIMARY KEY REFERENCES games (id) ON DELETE CASCADE,
  -- the full GameRecord as gzipped JSON
  record_gz  bytea NOT NULL,
  bytes      integer NOT NULL CHECK (bytes >= 0),
  -- retention: pruned after this
  expires_at timestamptz
);

CREATE TABLE game_players (
  game_id         bigint NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  client_id       text NOT NULL,
  -- resolved from the record's persistentID; null for unknown or deleted users
  user_id         uuid REFERENCES users (id) ON DELETE SET NULL,
  username        text NOT NULL,
  clan_tag        text,
  -- only set when the user was a member of that tag's clan at game start
  clan_id         bigint REFERENCES clans (id) ON DELETE SET NULL,
  result          text NOT NULL CHECK (result IN ('victory', 'defeat', 'incomplete')),
  -- plan 9.5: a completed game, for Credits and the clan threshold
  completed       boolean NOT NULL,
  credits_awarded bigint NOT NULL DEFAULT 0 CHECK (credits_awarded >= 0),
  stats           jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (game_id, client_id)
);
CREATE INDEX game_players_user_game_idx ON game_players (user_id, game_id DESC);
CREATE INDEX game_players_clan_game_idx ON game_players (clan_id, game_id DESC);
-- the clan-creation threshold counts these
CREATE INDEX game_players_user_completed_idx
  ON game_players (user_id) WHERE completed;

CREATE TABLE player_stat_aggregates (
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  game_type  text NOT NULL,
  mode       text NOT NULL,
  difficulty text NOT NULL,
  wins       bigint NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses     bigint NOT NULL DEFAULT 0 CHECK (losses >= 0),
  total      bigint NOT NULL DEFAULT 0 CHECK (total >= 0),
  -- element-wise sum of the engine's PlayerStats
  stats      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, game_type, mode, difficulty)
);

-- ---------------------------------------------------------------------------
-- Game servers and administration
-- ---------------------------------------------------------------------------

CREATE TABLE game_servers (
  site            text NOT NULL,
  letter          char(1) NOT NULL CHECK (letter ~ '^[a-z]$'),
  host            text NOT NULL,
  version         text NOT NULL,
  num_workers     integer NOT NULL CHECK (num_workers >= 1),
  live_games      integer NOT NULL DEFAULT 0 CHECK (live_games >= 0),
  machine         text,
  -- set by an admin, never taken from a check-in
  state           text NOT NULL DEFAULT 'open'
                    CHECK (state IN ('open', 'draining', 'fenced')),
  last_checkin_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site, letter)
);

CREATE TABLE server_api_keys (
  id         bigserial PRIMARY KEY,
  name       text NOT NULL,
  -- SHA-256 of the key; the key itself is shown once and never stored
  key_hash   bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE admin_audit_log (
  id          bigserial PRIMARY KEY,
  -- the operating-system user or the admin's id
  actor       text NOT NULL,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_log_created_idx ON admin_audit_log (created_at DESC);
