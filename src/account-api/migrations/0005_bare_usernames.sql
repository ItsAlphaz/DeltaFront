-- Operator-granted bare usernames ("Alphaz" instead of "Alphaz.3002").
--
-- Two separate things:
--   * `bare_username_enabled` is the ENTITLEMENT: whether the account may claim
--     a bare name. Only `npm run admin -- user:grant-bare-name` /
--     `user:revoke-bare-name` (audited) write it; no HTTP route can. It is
--     independent of `role`, `verified` and the subscription-style username
--     statuses, and every existing account starts without it.
--   * a bare name HELD is `username_base` set with `username_discriminator`
--     NULL. Revoking the entitlement leaves a held name in place (no silent
--     rewrite); the account just cannot claim a bare name again.
--
-- Bare names are unique among bare names, case-insensitively (username_base is
-- citext). That namespace is separate from "base.1234": claiming "Alphaz" takes
-- nothing from an account called "Alphaz.1234". Existing usernames are not
-- rewritten.

ALTER TABLE users ADD COLUMN bare_username_enabled boolean NOT NULL DEFAULT false;

-- 0001's unnamed CHECK required base and discriminator to be set together; a
-- bare name is a base without one. Find it by definition rather than by the
-- auto-generated name.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'users'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%username_base IS NULL%'
       AND pg_get_constraintdef(oid) LIKE '%username_discriminator IS NULL%'
  LOOP
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE users ADD CONSTRAINT users_username_form_check
  CHECK (username_discriminator IS NULL OR username_base IS NOT NULL);

CREATE UNIQUE INDEX users_bare_username_unique
  ON users (username_base)
  WHERE username_discriminator IS NULL AND username_base IS NOT NULL;
