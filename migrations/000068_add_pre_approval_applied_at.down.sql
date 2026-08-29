-- Reverses 000068. The column carries no other state and nothing depends on
-- it, so dropping it is clean — it only forgets when each buyer said they
-- applied. `deals.pre_approved` is untouched by this migration in either
-- direction, so the offer gate is unaffected by a rollback.
ALTER TABLE deals
  DROP COLUMN IF EXISTS pre_approval_applied_at;
