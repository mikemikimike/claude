/**
 * FF1 — best-effort notification emails on top of lib/email.ts.
 *
 * These helpers add best-effort EMAIL delivery for deal activity — new messages,
 * document uploads, task assignments, and offer requests. The matching in-app
 * `notifications` rows are persisted separately by the routes via
 * lib/notifications.ts (#290 wired up the document-upload and task-assignment
 * rows this header used to claim existed but did not). Each helper:
 *   - resolves recipients server-side from the deal (agent_id + deal_participants),
 *   - never emails the actor (sender / uploader / assigner),
 *   - is invoked best-effort by the route: a throw must never block the mutation
 *     (the route wraps the call in a try/catch that swallows — see the routes).
 *
 * The deep link is RECIPIENT-ROLE-AWARE: the app has no single per-deal route
 * shared across roles. Agents/admins use the agent deal route (`/agent/deals/:id`);
 * buyers and sellers land on their own portal (`/buyer/:userId`, `/seller/:userId`),
 * which is the only client deal view and is keyed by the user, not the deal; TCs
 * use the TC deals dashboard. A client-facing email must NOT link to the agent-only
 * route. The origin is taken from the request (`protocol://host`) so links work
 * across local / preview / prod without a hardcoded scheme.
 *
 * Preference / opt-out (#292): the Settings → Notifications "Email
 * notifications" toggle persists to `user_settings.settings.notifications.email`.
 * Every send here is gated PER-RECIPIENT on that key via `lib/notification-prefs`
 * — opted-out recipients are skipped while everyone else in the same fan-out
 * still gets theirs. It stays DEFAULT-ON: a missing row/key means "not yet
 * configured", which is opted-in (matching the Settings UI default).
 */
import { sendNotificationEmail } from "./email";
import {
  emailNotificationsEnabled,
  emailNotificationsEnabledFor,
} from "./notification-prefs";
import { prisma } from "./db";

function originFromRequest(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

/**
 * Role-appropriate deep link for a recipient. Clients land on their own portal
 * (keyed by their userId — the app's only client deal view); agents/admins use
 * the agent deal route; TCs use the TC deals dashboard.
 *
 * Exported (#291) so in-app notification hrefs reuse the EXACT same role→URL
 * mapping as these emails. Pass `origin=""` for a relative path (what the
 * Next `<Link>` in the notification bell wants); pass a real origin for the
 * absolute links the emails need.
 */
export function recipientUrl(
  origin: string,
  role: string,
  userId: string,
  dealId: string
): string {
  switch (role) {
    case "buyer":
      return `${origin}/buyer/${userId}`;
    case "seller":
      return `${origin}/seller/${userId}`;
    case "tc":
      return `${origin}/tc/deals`;
    default: // agent, admin, lending_partner
      return `${origin}/agent/deals/${dealId}`;
  }
}

type Participant = { user_id: string; email: string; role: string };
type Recipient = { userId: string; email: string; url: string };

/** The deal's client participants (buyers/sellers) with their emails + roles. */
async function clientParticipants(dealId: string): Promise<Participant[]> {
  return prisma.$queryRaw<Participant[]>`
    SELECT dp.user_id, u.email, dp.role::text AS role
    FROM deal_participants dp
    JOIN users u ON u.id = dp.user_id
    WHERE dp.deal_id = ${dealId}::uuid
      AND dp.role IN ('buyer', 'seller')
  `;
}

/**
 * The internal-thread TC recipients (#178): the deal agent's linked TC
 * (users.tc_user_id) plus any TC deal participants. UNION dedupes a linked TC
 * who is also a participant. Never returns buyers/sellers — the internal
 * thread is "Agent + TC only" (#177).
 */
async function internalTCs(dealId: string): Promise<Participant[]> {
  return prisma.$queryRaw<Participant[]>`
    SELECT tc.id AS user_id, tc.email, 'tc'::text AS role
    FROM deals d
    JOIN users agent ON agent.id = d.agent_id
    JOIN users tc ON tc.id = agent.tc_user_id
    WHERE d.id = ${dealId}::uuid
    UNION
    SELECT dp.user_id, u.email, 'tc'::text AS role
    FROM deal_participants dp
    JOIN users u ON u.id = dp.user_id
    WHERE dp.deal_id = ${dealId}::uuid AND dp.role = 'tc'
  `;
}

/** The deal's agent (id + email). */
async function dealAgent(
  dealId: string
): Promise<{ id: string; email: string } | null> {
  const rows = await prisma.$queryRaw<{ id: string; email: string }[]>`
    SELECT u.id, u.email
    FROM deals d
    JOIN users u ON u.id = d.agent_id
    WHERE d.id = ${dealId}::uuid
  `;
  return rows[0] ?? null;
}

/**
 * Send to each unique recipient with their own role-appropriate link, skipping
 * anyone who has turned email notifications OFF (#292). The preference is read
 * PER-RECIPIENT in one batched query, so opting one person out never suppresses
 * the others in the same fan-out.
 */
async function fanOut(
  recipients: Recipient[],
  fields: { subject: string; heading: string; body: string }
): Promise<void> {
  const seen = new Set<string>();
  const unique = recipients.filter((r) => {
    if (!r.email || seen.has(r.email)) return false;
    seen.add(r.email);
    return true;
  });
  if (unique.length === 0) return;

  const prefs = await emailNotificationsEnabledFor(unique.map((r) => r.userId));
  for (const r of unique) {
    if (prefs.get(r.userId) === false) continue; // recipient opted out
    await sendNotificationEmail({
      to: r.email,
      subject: fields.subject,
      heading: fields.heading,
      body: fields.body,
      dealUrl: r.url,
    });
  }
}

/**
 * New message: email the OTHER party. Never the sender.
 *
 * client_thread — agent sender → email the client participant(s); client
 * sender → email the agent.
 *
 * internal (#178) — the thread is "Agent + TC only" (#177), so clients are
 * NEVER emailed. Agent sender → email the TC(s) (the agent's linked TC +
 * any TC participants); TC sender → email the agent.
 */
export async function emailNewMessage(input: {
  req: Request;
  dealId: string;
  senderId: string;
  senderIsAgent: boolean;
  channel: "client_thread" | "internal";
  body: string;
}): Promise<void> {
  const { req, dealId, senderId, senderIsAgent, channel, body } = input;
  const origin = originFromRequest(req);
  const snippet = body.length > 140 ? body.slice(0, 140) + "…" : body;

  let recipients: Recipient[] = [];
  if (senderIsAgent && channel === "internal") {
    const tcs = await internalTCs(dealId);
    recipients = tcs
      .filter((tc) => tc.user_id !== senderId)
      .map((tc) => ({
        userId: tc.user_id,
        email: tc.email,
        url: recipientUrl(origin, tc.role, tc.user_id, dealId),
      }));
  } else if (senderIsAgent) {
    const clients = await clientParticipants(dealId);
    recipients = clients
      .filter((c) => c.user_id !== senderId)
      .map((c) => ({
        userId: c.user_id,
        email: c.email,
        url: recipientUrl(origin, c.role, c.user_id, dealId),
      }));
  } else {
    const agent = await dealAgent(dealId);
    if (agent && agent.id !== senderId) {
      recipients = [
        {
          userId: agent.id,
          email: agent.email,
          url: recipientUrl(origin, "agent", agent.id, dealId),
        },
      ];
    }
  }

  await fanOut(recipients, {
    subject: "New message on your RealTourFlow deal",
    heading: "You have a new message",
    body: `New message: "${snippet}"`,
  });
}

/**
 * Document uploaded/confirmed: email the deal's client(s) AND the deal's agent.
 * Never the uploader.
 *
 * The agent belongs in the recipient set whenever they are not the uploader
 * (#293): when a CLIENT uploads (the "please upload your pre-approval" reply),
 * the agent is the party waiting on it, yet the old client-only fan-out left
 * them out entirely — and on the common single-participant deal the recipient
 * set (clients minus the uploader) was empty, so nobody was emailed and the
 * request-a-doc loop dead-ended silently. When the AGENT uploads, `agent.id ===
 * uploaderId` so they are skipped and only the clients hear about it (unchanged,
 * no self-notify). fanOut dedupes by email, so an agent who is somehow also a
 * client participant is never emailed twice.
 */
export async function emailDocumentUploaded(input: {
  req: Request;
  dealId: string;
  uploaderId: string;
  documentName: string;
}): Promise<void> {
  const { req, dealId, uploaderId, documentName } = input;
  const origin = originFromRequest(req);

  const clients = await clientParticipants(dealId);
  const recipients = clients
    .filter((c) => c.user_id !== uploaderId)
    .map((c) => ({
      userId: c.user_id,
      email: c.email,
      url: recipientUrl(origin, c.role, c.user_id, dealId),
    }));

  const agent = await dealAgent(dealId);
  if (agent && agent.id !== uploaderId) {
    recipients.push({
      userId: agent.id,
      email: agent.email,
      url: recipientUrl(origin, "agent", agent.id, dealId),
    });
  }

  await fanOut(recipients, {
    subject: "A document was shared on your RealTourFlow deal",
    heading: "A document was shared with you",
    body: `"${documentName}" was added to your deal.`,
  });
}

/** Task assigned: email the assignee. Never email the actor who assigned it. */
export async function emailTaskAssigned(input: {
  req: Request;
  dealId: string;
  assigneeId: string;
  actorId: string;
  taskTitle: string;
}): Promise<void> {
  const { req, dealId, assigneeId, actorId, taskTitle } = input;
  if (!assigneeId || assigneeId === actorId) return;
  // #292 — skip if the assignee turned email notifications off.
  if (!(await emailNotificationsEnabled(assigneeId))) return;

  // Resolve the assignee's email + their role RELATIVE TO THIS DEAL so the link
  // points at the right area (agent route vs client portal vs TC dashboard).
  const rows = await prisma.$queryRaw<{ email: string; role: string }[]>`
    SELECT u.email,
      CASE WHEN d.agent_id = u.id THEN 'agent'
           ELSE COALESCE(dp.role::text, u.role::text) END AS role
    FROM users u
    JOIN deals d ON d.id = ${dealId}::uuid
    LEFT JOIN deal_participants dp
      ON dp.deal_id = d.id AND dp.user_id = u.id
    WHERE u.id = ${assigneeId}::uuid
  `;
  const row = rows[0];
  if (!row?.email) return;

  const origin = originFromRequest(req);
  await sendNotificationEmail({
    to: row.email,
    subject: "You've been assigned a task on RealTourFlow",
    heading: "You've been assigned a task",
    body: `You were assigned: "${taskTitle}".`,
    dealUrl: recipientUrl(origin, row.role, assigneeId, dealId),
  });
}

/**
 * Offer requested on a tracked property (#168): email the deal's agent.
 * Never the requester — if the agent flips the flag themselves, no email.
 * Invoked best-effort by the property PATCH route (a throw must never block
 * the mutation).
 */
export async function emailOfferRequested(input: {
  req: Request;
  dealId: string;
  requesterId: string;
  propertyAddress: string;
}): Promise<void> {
  const { req, dealId, requesterId, propertyAddress } = input;
  const agent = await dealAgent(dealId);
  if (!agent || agent.id === requesterId) return;

  const origin = originFromRequest(req);
  await fanOut(
    [
      {
        userId: agent.id,
        email: agent.email,
        url: recipientUrl(origin, "agent", agent.id, dealId),
      },
    ],
    {
      subject: "Offer request on your RealTourFlow deal",
      heading: "Your client wants to make an offer",
      body: `Your client requested to make an offer on "${propertyAddress}". Reach out to discuss next steps.`,
    }
  );
}

/**
 * Intake UPDATED (#427): the client edited an already-submitted questionnaire
 * from the portal's *Your preferences* screen. Email the deal's agent.
 *
 * Only UPDATES reach here — a first submission is already announced by the
 * invite claim, and sending both would double up on the same event. The body
 * carries the same one-line highlights the claim email uses, so a changed
 * budget or must-have is visible without opening the app; the full answers are
 * on the deal's Client Intake panel, which the link points at.
 *
 * Never emails the client who made the edit (they know), and never the deal's
 * other participants — this is agent-facing news. Best-effort: the route wraps
 * the call so a send failure cannot fail the client's save.
 */
export async function emailIntakeUpdated(input: {
  req: Request;
  dealId: string;
  role: "buyer" | "seller";
  answers: Record<string, unknown>;
  /** The client who made the edit — never emailed. */
  updatedBy: string;
}): Promise<void> {
  const { req, dealId, role, answers, updatedBy } = input;
  const agent = await dealAgent(dealId);
  if (!agent || agent.id === updatedBy) return;

  const origin = originFromRequest(req);
  const who = role === "buyer" ? "buyer" : "seller";
  await fanOut(
    [
      {
        userId: agent.id,
        email: agent.email,
        url: recipientUrl(origin, "agent", agent.id, dealId),
      },
    ],
    {
      subject: `Your ${who} updated their intake answers`,
      heading: "Updated intake answers",
      body:
        `Your ${who} changed what they told you in onboarding.` +
        `${formatIntakeHighlights(role, answers)} Open the deal to see the full intake.`,
    }
  );
}

/**
 * Form reviewed (#295): an admin approved or rejected an agent-uploaded form.
 * Email the OWNING AGENT so they learn the outcome without having to reopen
 * Settings → My Forms and notice a status chip changed. A rejection carries the
 * admin's stated reason (`reviewNotes`) when present; an approval is a simple
 * "it's ready to use" confirmation.
 *
 * Single-recipient (the form's owner), gated on that agent's email-notification
 * preference (#292). Invoked best-effort by POST /api/admin/forms/:id AFTER the
 * status write, wrapped in the route's try/catch so a send failure can never
 * block the admin's approve/reject action.
 */
export async function emailFormReviewed(input: {
  req: Request;
  formId: string;
  action: "approve" | "reject";
  reviewNotes?: string | null;
}): Promise<void> {
  const { req, formId, action, reviewNotes } = input;

  // Resolve the owning agent (id + email) + the form label from the form row.
  const rows = await prisma.$queryRaw<
    { agent_id: string; email: string; label: string }[]
  >`
    SELECT f.agent_id, u.email, f.label
    FROM uploaded_forms f
    JOIN users u ON u.id = f.agent_id
    WHERE f.id = ${formId}::uuid
  `;
  const row = rows[0];
  if (!row?.email) return;
  // #292 — respect the agent's "Email notifications" opt-out.
  if (!(await emailNotificationsEnabled(row.agent_id))) return;

  const origin = originFromRequest(req);
  // The agent's forms live under Settings → My Forms; there is no per-form deep
  // link, so point at their settings page (the actionable surface).
  const formsUrl = `${origin}/agent/settings`;
  const label = row.label || "your form";

  if (action === "approve") {
    await sendNotificationEmail({
      to: row.email,
      subject: `Your form "${label}" is ready to use`,
      heading: "Your form was approved",
      body: `"${label}" passed review and is now available to send on your deals.`,
      dealUrl: formsUrl,
    });
    return;
  }

  // reject — include the admin's stated reason when one was given.
  const reason = (reviewNotes ?? "").trim();
  const body = reason
    ? `"${label}" was rejected. Reason: ${reason}. Open My Forms in Settings to re-upload a corrected version.`
    : `"${label}" was rejected. Open My Forms in Settings to re-upload a corrected version.`;
  await sendNotificationEmail({
    to: row.email,
    subject: `Your form "${label}" needs another look`,
    heading: "Your form was rejected",
    body,
    dealUrl: formsUrl,
  });
}

/**
 * Disclosure reminder (#303): the admin "Send Reminder" button nudges the
 * deal's client(s) — the party who must sign — about disclosures that were sent
 * but not yet signed. Mirrors the other helpers: resolves the buyer/seller
 * participants server-side, links each to their own portal, and fans out with
 * the same per-recipient opt-out + dedupe. Admin-triggered, so there is no
 * actor to skip. Invoked best-effort by the admin disclosure-reminder route.
 */
export async function emailDisclosureReminder(input: {
  req: Request;
  dealId: string;
}): Promise<void> {
  const { req, dealId } = input;
  const origin = originFromRequest(req);

  const clients = await clientParticipants(dealId);
  const recipients = clients.map((c) => ({
    userId: c.user_id,
    email: c.email,
    url: recipientUrl(origin, c.role, c.user_id, dealId),
  }));

  await fanOut(recipients, {
    subject: "Reminder: your disclosures need a signature",
    heading: "Please sign your disclosures",
    body: "Your loan disclosures were sent but haven't been signed yet. Please review and sign them so your closing stays on track.",
  });
}

// ---------------------------------------------------------------------------
// #175 — intake highlights for the "client joined" agent notification.
// Append-only addition: turns the persisted onboarding answers into a compact
// one-line summary the invite-claim route appends to its email body, so the
// agent's "client joined" email carries real context instead of arriving bare.
// ---------------------------------------------------------------------------

const LENDER_LABELS: Record<string, string> = {
  mountain: "Mountain Mortgage",
  fastpass: "Fast Pass (Mountain Mortgage)",
  other: "Using another lender",
};

function moneyShort(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  return `$${Math.round(n / 1000)}K`;
}

/**
 * A compact " Intake highlights — …" sentence from the questionnaire answers,
 * or "" when there is nothing worth surfacing. Plain text — callers pass it
 * through sendNotificationEmail, which HTML-escapes the body.
 */
export function formatIntakeHighlights(
  role: "buyer" | "seller",
  answers: Record<string, unknown>
): string {
  const str = (k: string): string | null => {
    const v = answers[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const num = (k: string): number | null => {
    const v = answers[k];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };

  const parts: string[] = [];
  if (role === "buyer") {
    const min = num("minBudget");
    const max = num("maxBudget");
    if (min !== null && max !== null) parts.push(`Budget ${moneyShort(min)}–${moneyShort(max)}`);
    const beds = str("bedrooms");
    const baths = str("bathrooms");
    if (beds) parts.push(`${beds} bed${baths ? ` / ${baths} bath` : ""}`);
    const areas = str("areas");
    if (areas) parts.push(`Areas: ${areas}`);
    const journey = str("journeyStage");
    if (journey) parts.push(journey);
    const lender = str("lenderChoice");
    if (lender) parts.push(`Lender: ${LENDER_LABELS[lender] ?? lender}`);
    const tracking = str("trackingAddress");
    if (tracking) parts.push(`First property: ${tracking}`);
  } else {
    const address = str("address");
    if (address) parts.push(`Property: ${address}`);
    const listDate = str("desiredListDate");
    if (listDate) parts.push(`Target list: ${listDate}`);
    const priority = str("whatMattersMost");
    if (priority) parts.push(`Priority: ${priority}`);
    const reasons = answers.reasonsForSelling;
    if (Array.isArray(reasons)) {
      const items = reasons.filter((r): r is string => typeof r === "string" && r.trim() !== "");
      if (items.length > 0) parts.push(`Reason: ${items.join(", ")}`);
    }
    const lender = str("lenderChoice");
    if (lender) parts.push(`Lender: ${LENDER_LABELS[lender] ?? lender}`);
  }

  return parts.length > 0 ? ` Intake highlights — ${parts.join(" · ")}.` : "";
}
