-- Reverses 000066. The answers themselves are untouched by the up migration —
-- they still live in `deals.intake` — so dropping the column loses only the
-- agent's manual corrections, and the read path derives from the JSON again.
ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_financing_type_check;
ALTER TABLE deals DROP COLUMN IF EXISTS financing_type;
