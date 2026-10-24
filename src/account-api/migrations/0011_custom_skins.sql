-- "Create Your Own": the territory skins an account drew with the shop's skin
-- creator. A few slots per account (the limit is the code's, MAX_CUSTOM_SKINS);
-- the pattern data is the same one-bit tile the catalog's skins use, validated
-- on save and again by the game server at join. Deleting the account deletes
-- its designs.
CREATE TABLE custom_skins (
  user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  slot            smallint    NOT NULL CHECK (slot BETWEEN 0 AND 4),
  name            text        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 20),
  pattern_data    text        NOT NULL CHECK (char_length(pattern_data) <= 1403),
  primary_color   text        NOT NULL CHECK (primary_color ~ '^#[0-9a-f]{6}$'),
  secondary_color text        NOT NULL CHECK (secondary_color ~ '^#[0-9a-f]{6}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, slot)
);
