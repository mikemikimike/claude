-- Give the Transaction Coordinator invite a TOKEN, an expiry, and a single
-- claim — the three things #415/#444 shipped without (#446).
--
-- Until now the agent's `users.tc_contact` row WAS the pending invite: it had
-- no token and no expiry, and `pendingTcContactRole()` / `linkTcContacts()`
-- matched it on EMAIL ALONE. So whoever controlled an invited address could
-- sign up at any point, forever, and be silently linked as that agent's TC —
-- and `listDealsForUser` scopes a TC by `users.tc_user_id`, i.e. the agent's
-- ENTIRE pipeline: every deal, client contact details, and document. An agent
-- typing `tina@gmial.com` handed that to whoever owns the typo domain.
--
-- This is deal_invites' shape (migration 000008), deliberately, rather than a
-- third invite pattern: token UUID UNIQUE, expires_at defaulting to 7 days,
-- claimed_at/claimed_by for single-claim.
CREATE TABLE tc_invites (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The inviting agent. CASCADE because a pending TC invite is meaningless
    -- once the agent it points at is gone (deal_invites cascades off deals for
    -- the same reason).
    agent_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    token       UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    claimed_at  TIMESTAMPTZ,
    claimed_by  UUID REFERENCES users(id),
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The claim path looks an invite up by token.
CREATE INDEX tc_invites_token_idx ON tc_invites (token);

-- The re-invite path (PUT /api/me/tc, DELETE /api/me/tc) expires an agent's
-- own open invites before issuing a new one.
CREATE INDEX tc_invites_agent_open_idx
  ON tc_invites (agent_id)
  WHERE claimed_at IS NULL;

-- Sibling of 000061: `lower(email) = lower($1)`, partial on unclaimed, is the
-- only case-insensitive form a btree can serve. Nothing on the login path
-- reads this today (the claim is by token), but the invite-listing and
-- re-invite lookups match on it and Prisma's `mode: "insensitive"` would emit
-- an unindexable ILIKE.
CREATE INDEX tc_invites_lower_email_open_idx
  ON tc_invites (lower(email))
  WHERE claimed_at IS NULL;

-- Scope item 2 of #446: the login-path sequential scan.
--
-- `linkTcContacts()` ran on EVERY /api/users/sync and filtered on
-- `lower(tc_contact->>'email')` — a JSONB extraction no index could serve, so
-- every login sequentially scanned `users`. It is deleted outright by this
-- change (the token claim links the TC exactly once, at claim time), which
-- removes the scan rather than indexing it.
--
-- What remains is the reverse lookup: "is this user still somebody's linked
-- TC?", which now backs both `listDealsForUser`'s TC scope
-- (`agent_id IN (SELECT id FROM users WHERE tc_user_id = $1)`) and the TC
-- role-revocation rule in decideRole. `users.tc_user_id` had no index at all.
-- Partial because the overwhelming majority of rows are NULL.
CREATE INDEX users_tc_user_id_idx
  ON users (tc_user_id)
  WHERE tc_user_id IS NOT NULL;

-- NOTHING IS BACKFILLED, on purpose.
--
-- Any `users.tc_contact` written before this migration with `tc_user_id IS
-- NULL` is an untokenized pending invite. Minting `tc_invites` rows for those
-- would keep them claimable — exactly what this ticket exists to stop — so
-- they are simply no longer honoured: the contact stays visible on the agent's
-- Settings card as "Invite pending" and grants nothing. The agent re-saves the
-- TC to issue a real, tokened, 7-day invite.
--
-- Already-LINKED TCs (`tc_user_id IS NOT NULL`) are untouched and keep working.
