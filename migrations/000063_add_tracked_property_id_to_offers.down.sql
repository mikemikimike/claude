DROP INDEX IF EXISTS idx_offers_tracked_property_id;

ALTER TABLE offers
  DROP COLUMN IF EXISTS tracked_property_id;
