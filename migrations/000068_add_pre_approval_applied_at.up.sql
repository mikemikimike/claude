-- #437 (FF14) — two-state pre-approval.
--
-- `deals.pre_approved` is the OFFER GATE and stays exactly what it was: agent
-- (own deals) or admin only. This column is the other, weaker state — "the
-- buyer says they applied" — which the buyer themselves may set. It closes
-- their pre-approval task and changes no gate.
--
-- A real column rather than a read of the task's status: task status is edited
-- for unrelated reasons (an agent reopening it, a buyer un-ticking it), and the
-- date the buyer acted has to survive that.
--
-- Additive and nullable, so every existing deal reads "never applied" with no
-- backfill.
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS pre_approval_applied_at TIMESTAMPTZ;
