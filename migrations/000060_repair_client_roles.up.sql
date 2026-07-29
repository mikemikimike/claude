-- Repair clients who were turned into agents by the role clobber.
--
-- The Auth0 tenant hands every new signup a default `agent` roles claim. Until
-- lib/roles.ts#decideRole landed, POST /api/users/sync let that claim win
-- unconditionally: an invited buyer/seller's role was written correctly by the
-- invite claim and then overwritten with `agent` on the very next sync, which
-- dropped them into the agent app instead of their client portal.
--
-- A claimed deal_invites row is the record of what they were actually invited
-- as, so it is the authority for the repair. The NOT EXISTS guard is the safety
-- net: anyone who genuinely owns deals as an agent (e.g. an agent who also
-- accepted a client invite for their own email) is left alone.
UPDATE users u
SET role = di.role::user_role,
    updated_at = NOW()
FROM deal_invites di
WHERE di.claimed_by = u.id
  AND u.role = 'agent'
  AND di.role IN ('buyer', 'seller')
  AND NOT EXISTS (SELECT 1 FROM deals d WHERE d.agent_id = u.id);
