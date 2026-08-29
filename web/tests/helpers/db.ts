/**
 * Per-test DB helpers. Relies on the globalSetup having booted a Testcontainers
 * Postgres and exposed DATABASE_URL.
 */
import { prisma } from "@/lib/db";

const USER_DATA_TABLES = [
  "audit_log",
  "calendar_event_map",
  "oauth_tokens",
  "notifications",
  "message_reads",
  "messages",
  "documents",
  "checklist_items",
  "deal_inspection_items",
  "deal_contingencies",
  "deal_stage_history",
  "deal_participants",
  "deal_invites",
  "tc_invites",
  "offers",
  "net_sheets",
  "tracked_properties",
  "uploaded_form_fields",
  "known_forms",
  "form_types",
  "form_promotions",
  "brokerages",
  "uploaded_forms",
  "tasks",
  "deals",
  "agent_invites",
  "preferred_vendors",
  "promo_codes",
  "user_settings",
  "users",
];

/**
 * Truncates every user-data table. Preserves schema_migrations + system_config.
 * Call in beforeEach for test isolation.
 */
export async function truncateAll(): Promise<void> {
  // Single statement — CASCADE handles FK relations.
  const list = USER_DATA_TABLES.map((t) => `"${t}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
