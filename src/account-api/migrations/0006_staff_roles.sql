-- Staff roles, a richer audit trail and admin-modified games.
--
--  * users.role gains `owner` above `admin`. (`root` stays accepted: it is
--    upstream's spelling and is read as owner.) `owner` is only ever assigned
--    by `npm run admin -- user:role ... owner` on the server, never over HTTP.
--  * admin_audit_log learns WHO acted as an account and in what capacity, and
--    from where, so the web panel and the game server can write the same log as
--    the CLI. `actor` stays the human-readable name (the OS user, or the
--    account's public id).
--  * games.admin_modified marks a game in which an in-game admin command
--    changed the state. Such a game never counts for stats, Credits or the
--    leaderboard (domain/ingest.ts derives it from the record's turns).
--
-- Nothing is rewritten; every existing row keeps its meaning.

DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'users'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%role%'
       AND pg_get_constraintdef(oid) LIKE '%flagged%'
  LOOP
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('owner', 'root', 'admin', 'mod', 'flagged'));

ALTER TABLE admin_audit_log
  ADD COLUMN actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN actor_role    text,
  ADD COLUMN source        text NOT NULL DEFAULT 'cli'
                             CHECK (source IN ('cli', 'web', 'game'));

CREATE INDEX admin_audit_log_target_idx
  ON admin_audit_log (target_type, target_id, created_at DESC);
CREATE INDEX admin_audit_log_actor_idx
  ON admin_audit_log (actor_user_id, created_at DESC);
CREATE INDEX admin_audit_log_action_idx
  ON admin_audit_log (action, created_at DESC);

ALTER TABLE games ADD COLUMN admin_modified boolean NOT NULL DEFAULT false;
