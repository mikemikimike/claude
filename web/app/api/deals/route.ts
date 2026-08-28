import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db";
import { error, json, withAuth } from "@/lib/http";
import { hasRole } from "@/lib/roles";
import { resolveUserId } from "@/lib/users";
import { listDealsForUser } from "@/lib/deals";
import { createDealBodySchema, DEAL_STATUSES } from "@/lib/schemas/deal";
import { parseBody } from "@/lib/schemas/parse";

/**
 * Read `?status=` into what `listDealsForUser` wants (#254, widened in #417).
 *
 * - absent / unrecognized → `undefined`, i.e. the active-only default. An
 *   unknown status must NOT return an empty list: the pipeline silently going
 *   blank on a typo is worse than ignoring the param.
 * - `all` → every status.
 * - one valid status → just that one.
 * - a comma list (`archived,fallen_through` — the dashboard's Completed
 *   section) → any of them. Unknown entries are dropped, and a list with
 *   nothing valid left in it falls back to the default like any other garbage.
 *
 * Only members of DEAL_STATUSES ever reach the query, so an attacker-supplied
 * value can never widen the caller's visibility scope (which is a separate
 * AND-ed condition) or reach SQL as anything but a bound parameter.
 */
function parseStatusFilter(raw: string | null): string | string[] | undefined {
  if (!raw) return undefined;
  if (raw === "all") return "all";
  const valid = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => (DEAL_STATUSES as readonly string[]).includes(s));
  // De-duplicate so `?status=archived,archived` stays a single equality.
  const unique = [...new Set(valid)];
  if (unique.length === 0) return undefined;
  return unique.length === 1 ? unique[0] : unique;
}

export async function GET(req: Request): Promise<Response> {
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found — call /users/sync first", 404);
    const statusFilter = parseStatusFilter(new URL(req.url).searchParams.get("status"));
    const deals = await listDealsForUser(userId, {
      isAdmin: hasRole(claims.roles, ["admin"]),
      isTC: hasRole(claims.roles, ["tc"]),
      statusFilter,
    });
    return json(deals);
  })) as Response;
}

export async function POST(req: Request): Promise<Response> {
  return (await withAuth(req, async (claims): Promise<Response> => {
    // Deal creation is restricted to agents (and admins). Every other role
    // (buyer/seller/tc/lending_partner) would otherwise create a deal owned
    // by themselves as agent_id. Reject before doing any work (#274). Client
    // deals are created via the invite flow, not this endpoint.
    if (!hasRole(claims.roles, ["agent", "admin"])) {
      return error("only agents can create deals", 403);
    }

    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found — call /users/sync first", 404);

    const parsed = await parseBody(req, createDealBodySchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const type = body.type;
    if (!title || (type !== "buy" && type !== "sell")) {
      return error("title and type (buy|sell) are required", 400);
    }

    const rows = await prisma.$queryRaw<
      {
        id: string;
        agent_id: string;
        type: string;
        stage: string;
        title: string;
        address: string | null;
        price: string | null;
        arive_linked: boolean;
        closing_date: string | null;
        created_at: Date;
        updated_at: Date;
      }[]
    >`
      INSERT INTO deals (agent_id, type, title, address, price, arive_linked, closing_date, market)
      VALUES (${userId}::uuid, ${type}::deal_type, ${title},
              ${body.address ?? null},
              ${body.price ?? null}::decimal,
              ${body.arive_linked ?? false},
              ${body.closing_date ?? null}::date,
              COALESCE((SELECT market FROM users WHERE id = ${userId}::uuid), ''))
      RETURNING id, agent_id, type::text AS type, stage::text AS stage,
                title, address, price::text AS price, arive_linked,
                closing_date::text AS closing_date, created_at, updated_at
    `;
    return json({ ...rows[0], health: "green" }, 201);
  })) as Response;
}

// Make eslint happy about Prisma import (used for Prisma.sql in deals.ts).
export const _unused = Prisma;
