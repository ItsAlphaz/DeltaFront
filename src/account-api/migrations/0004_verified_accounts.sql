-- Operator-granted verified accounts (the blue check).
--
-- `verified` is set only by `npm run admin -- user:verify` / `user:unverify`
-- (audited); no HTTP route writes it and a client can only ever ask to play
-- under the check, never grant it. It is independent of `role` (an admin is
-- not verified unless someone verified them) and of the username status, so
-- it does not need a bare or premium name.

ALTER TABLE users ADD COLUMN verified boolean NOT NULL DEFAULT false;
