-- Per-item inspection follow-up tracking (#429).
--
-- The `inspection_followup` Fast Pass add-on is sold at $147 and promises that
-- every finding in the inspection report gets chased to completion, but until
-- now nothing stored those findings. `deal_contingencies` covers the inspection
-- *contingency* (one row, one deadline) — not the twenty-to-sixty individual
-- repair items a real report produces. This table is those items.
--
-- Modelled on `checklist_items` (000007): per-deal list, enum-typed columns,
-- explicit `sort_order` so the agent can keep the report's own ordering, and
-- ON DELETE CASCADE from `deals` so deleting a deal takes its items with it.
--
-- `document_id` is the optional link back to the uploaded inspection report the
-- item was read off. It is ON DELETE SET NULL, not CASCADE: deleting the source
-- PDF must never silently delete the tracked repair items derived from it.

-- open      — entered off the report, nothing requested yet
-- requested — repair asked of the seller / counterparty
-- scheduled — a vendor or re-inspection is booked
-- resolved  — the work is done
-- waived    — deliberately dropped (credit taken, buyer accepted as-is)
--
-- 'resolved' and 'waived' are both terminal: an item in either state is closed
-- out and needs no further chasing. Slice (c) reads that distinction when it
-- drives the Fast Pass tracker off real item state.
CREATE TYPE inspection_item_status AS ENUM (
    'open', 'requested', 'scheduled', 'resolved', 'waived'
);

CREATE TYPE inspection_item_severity AS ENUM (
    'minor', 'moderate', 'major', 'safety'
);

-- Who is on the hook for the item, mirroring checklist_assignee's vocabulary.
CREATE TYPE inspection_item_owner AS ENUM (
    'seller', 'buyer', 'agent', 'tc', 'third_party'
);

CREATE TABLE deal_inspection_items (
    id          UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id     UUID                     NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    document_id UUID                     REFERENCES documents(id) ON DELETE SET NULL,
    sort_order  INTEGER                  NOT NULL DEFAULT 0,
    category    TEXT                     NOT NULL DEFAULT 'General',
    description TEXT                     NOT NULL,
    severity    inspection_item_severity NOT NULL DEFAULT 'moderate',
    status      inspection_item_status   NOT NULL DEFAULT 'open',
    owner       inspection_item_owner    NOT NULL DEFAULT 'seller',
    notes       TEXT,
    resolved_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ              NOT NULL DEFAULT NOW()
);

-- Every read is "the items on this deal, in report order" — the list route and
-- (in slice c) the buyer's progress summary both run exactly this.
CREATE INDEX idx_deal_inspection_items_deal_sort
    ON deal_inspection_items (deal_id, sort_order);
