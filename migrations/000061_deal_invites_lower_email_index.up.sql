-- Make the open-invite lookup index-able again.
--
-- migrations/000008 already indexes deal_invites (email) WHERE claimed_at IS NULL,
-- and that worked while the lookup was case-sensitive. It stopped being usable
-- when pendingInviteRole() started matching case-insensitively — which it must,
-- because Auth0 hands back a normalized address while the agent types whatever
-- they type into the invite form, and a case miss silently drops the invited
-- role and creates the client as an agent.
--
-- A btree on email cannot serve `lower(email) = lower($1)`, so that lookup fell
-- back to a sequential scan. Measured on 100k rows: 34.6ms seq scan vs 0.11ms
-- with this functional index. It runs on the login hot path — resolveSyncRole()
-- calls it on every brand-new user's first sync — so it is worth indexing
-- before the table grows, even though the table is tiny today.
--
-- Partial on claimed_at IS NULL to match both the query and the sibling index:
-- a claimed invite is never a candidate, so it does not belong in the index.
CREATE INDEX IF NOT EXISTS deal_invites_lower_email_open_idx
  ON deal_invites (lower(email))
  WHERE claimed_at IS NULL;
