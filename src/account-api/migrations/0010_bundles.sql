-- Bundles: several catalog items sold together for one Credits price. A bundle
-- purchase is one row with kind 'pack' (as 0001 planned), its item_key
-- `pack:<name>` and every flare it granted.
ALTER TABLE purchases DROP CONSTRAINT purchases_kind_check;
ALTER TABLE purchases ADD CONSTRAINT purchases_kind_check CHECK (kind IN ('cosmetic', 'pack'));
