-- #410: an offer must say WHICH property it is on.
--
-- `offers` has carried `offer_price` since 000019 but no link to the
-- `tracked_properties` row the offer was written against, so the app inferred
-- the property from whichever listing the buyer happened to tap "Make an
-- Offer" on. Nullable so the existing rows (and any seller-side offer, which
-- is not against a tracked property) stay valid; ON DELETE SET NULL so
-- removing a tracked listing never cascades away the offer history.
ALTER TABLE offers
  ADD COLUMN tracked_property_id UUID REFERENCES tracked_properties(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_offers_tracked_property_id
  ON offers (tracked_property_id);
