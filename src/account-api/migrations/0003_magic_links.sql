-- Email magic-link sign-in (milestone M8; docs/DeltaFrontAccountsPlan.md 6.1).
--
-- One row per emailed link. Only the SHA-256 of the token is stored: the
-- token itself exists in the email and in the link the player opens, never in
-- this database or in a log. A row is single use (`consumed_at`), lives for
-- 15 minutes (`expires_at`) and is deleted by the maintenance job after a day.
-- The address is kept until then because completing the sign-in needs it.

CREATE TABLE magic_link_tokens (
  token_hash      bytea PRIMARY KEY,
  email           citext NOT NULL,
  -- the site origin the link points at, checked against ALLOWED_ORIGINS
  redirect_domain text NOT NULL,
  -- set when an already signed-in registered account asked for the link, so
  -- that completing it attaches the address to THAT account
  link_user_id    uuid REFERENCES users (id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  -- keyed hash of the requester's address (see repo/sessions.ts hashIp)
  request_ip_hash bytea,
  CHECK (expires_at > created_at)
);

-- the per-address rate limit counts recent requests
CREATE INDEX magic_link_tokens_email_created_idx
  ON magic_link_tokens (email, created_at);
-- the cleanup job and the "pending" count read by expiry
CREATE INDEX magic_link_tokens_expires_idx ON magic_link_tokens (expires_at);
