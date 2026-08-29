-- #451 — promote the buyer's cash/loan answer from the free-form `deals.intake`
-- JSON to a real column.
--
-- #409 derived it on every read (financingTypeFromIntake in web/lib/intake.ts),
-- which coupled the pre-approval offer gate to a questionnaire key name and
-- made every deal list SELECT ~1-2 KB of intake JSON to extract one string.
--
-- NULLABLE ON PURPOSE: "this buyer never answered" must stay distinguishable
-- from "cash". Only an explicit 'cash' lifts the pre-approval offer gate, so
-- an unknown financing type has to fail closed, exactly as it does today.
ALTER TABLE deals ADD COLUMN financing_type TEXT;

ALTER TABLE deals
  ADD CONSTRAINT deals_financing_type_check
  CHECK (financing_type IS NULL OR financing_type IN ('cash', 'loan'));

-- Backfill from the intake JSON #409 read, mirroring financingTypeFromIntake()
-- in web/lib/intake.ts exactly:
--   * buyer questionnaires only (financing is a buy-side question),
--   * `intake` and `intake->answers` must both be JSON objects,
--   * the answer must be the literal JSON STRING 'cash' or 'loan'.
-- Anything else stays NULL. `deals.intake` is client-written free-form JSON and
-- a wrong 'cash' unlocks the offer CTA for a financed buyer who has no letter,
-- so this never guesses — it only copies an answer that is already unambiguous.
UPDATE deals
SET financing_type = intake -> 'answers' ->> 'cashOrLoan'
WHERE financing_type IS NULL
  AND jsonb_typeof(intake) = 'object'
  AND intake ->> 'role' = 'buyer'
  AND jsonb_typeof(intake -> 'answers') = 'object'
  AND jsonb_typeof(intake -> 'answers' -> 'cashOrLoan') = 'string'
  AND intake -> 'answers' ->> 'cashOrLoan' IN ('cash', 'loan');
