-- The Vault (docs/Vault.md): a spin wheel and packs paid for with Credits.
--
-- vault_draws is the record of every spin and pack the server drew: what it
-- cost, what came out, and the client's request id, so a retried request (a
-- double click, a dropped connection) answers with the same result and never
-- charges twice. vault_pity counts the packs since a rare or an epic card,
-- per account and pack type, for the bad-luck guarantee.

CREATE TABLE vault_draws (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- 'spin' (paid), 'daily' (the free daily spin) or 'pack'
  kind       text NOT NULL CHECK (kind IN ('spin', 'daily', 'pack')),
  -- the pack's name, or 'wheel'
  item_key   text NOT NULL,
  cost       bigint NOT NULL CHECK (cost >= 0),
  -- the whole result as the API answered it
  result     jsonb NOT NULL,
  -- UTC day, for the daily limits
  day        date NOT NULL,
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vault_draws_request_once ON vault_draws (user_id, request_id);
-- one free spin per account and UTC day
CREATE UNIQUE INDEX vault_draws_daily_once ON vault_draws (user_id, day)
  WHERE kind = 'daily';
CREATE INDEX vault_draws_user_day_idx ON vault_draws (user_id, day, kind);
CREATE INDEX vault_draws_user_created_idx ON vault_draws (user_id, created_at DESC);

CREATE TABLE vault_pity (
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  pack         text NOT NULL,
  since_rare   integer NOT NULL DEFAULT 0 CHECK (since_rare >= 0),
  since_epic   integer NOT NULL DEFAULT 0 CHECK (since_epic >= 0),
  PRIMARY KEY (user_id, pack)
);

-- the ledger's reasons: what a draw cost, and what it paid out (Credits prizes
-- and the refunds for duplicates)
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'currency_ledger'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%progression_reward%'
  LOOP
    EXECUTE format('ALTER TABLE currency_ledger DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE currency_ledger ADD CONSTRAINT currency_ledger_reason_check
  CHECK (reason IN ('purchase', 'game_reward', 'admin_grant', 'admin_revoke',
                    'refund', 'progression_reward', 'vault_spend', 'vault_payout'));

-- user_flares.source gains 'vault' (a cosmetic won from the Vault).
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'user_flares'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%purchase%'
       AND pg_get_constraintdef(oid) LIKE '%reward%'
  LOOP
    EXECUTE format('ALTER TABLE user_flares DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE user_flares ADD CONSTRAINT user_flares_source_check
  CHECK (source IN ('purchase', 'admin', 'reward', 'vault'));
