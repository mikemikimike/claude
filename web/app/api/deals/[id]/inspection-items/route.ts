import { error, json, withAuth } from "@/lib/http";
import { prisma } from "@/lib/db";
import { resolveUserId } from "@/lib/users";
import {
  INSPECTION_ITEM_OWNERS,
  INSPECTION_ITEM_SEVERITIES,
  type InspectionItemOwner,
  type InspectionItemSeverity,
} from "@/lib/inspection-items";
import { inspectionItemAccess } from "@/lib/inspection-item-access";

type Ctx = { params: Promise<{ id: string }> };

const ITEM_SELECT = {
  id: true,
  deal_id: true,
  document_id: true,
  sort_order: true,
  category: true,
  description: true,
  severity: true,
  status: true,
  owner: true,
  notes: true,
  resolved_at: true,
  created_at: true,
  updated_at: true,
} as const;

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const { id: dealId } = await ctx.params;
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);
    const access = await inspectionItemAccess(dealId, userId, claims.roles);
    if (!access.canRead) return error("deal not found", 404);

    const items = await prisma.deal_inspection_items.findMany({
      where: { deal_id: dealId },
      orderBy: [{ sort_order: "asc" }, { created_at: "asc" }],
      select: ITEM_SELECT,
    });
    return json(items);
  })) as Response;
}

type CreateBody = {
  description?: string;
  category?: string;
  severity?: string;
  owner?: string;
  notes?: string;
  document_id?: string | null;
};

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { id: dealId } = await ctx.params;
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);
    const access = await inspectionItemAccess(dealId, userId, claims.roles);
    // 404 hides the deal from a stranger; 403 tells a participant (the buyer)
    // the truth — they can see this list, they just don't edit it.
    if (!access.canRead) return error("deal not found", 404);
    if (!access.canWrite) return error("read-only access to this deal", 403);

    let body: CreateBody;
    try {
      body = (await req.json()) as CreateBody;
    } catch {
      return error("description is required", 400);
    }

    const description = (body.description ?? "").trim();
    if (!description) return error("description is required", 400);

    const severity = body.severity ?? "moderate";
    if (!(INSPECTION_ITEM_SEVERITIES as readonly string[]).includes(severity)) {
      return error("invalid severity", 400);
    }
    const owner = body.owner ?? "seller";
    if (!(INSPECTION_ITEM_OWNERS as readonly string[]).includes(owner)) {
      return error("invalid owner", 400);
    }

    // A document_id from another deal would leak that deal's document into this
    // one's item list, so it is checked against THIS deal rather than trusted.
    let documentId: string | null = null;
    if (body.document_id) {
      const doc = await prisma.documents.findFirst({
        where: { id: body.document_id, deal_id: dealId },
        select: { id: true },
      });
      if (!doc) return error("document not found on this deal", 400);
      documentId = doc.id;
    }

    // Append to the end so the agent can key items in the report's own order.
    // Two concurrent creates can pick the same sort_order; that is deliberate —
    // sort_order is presentation, not identity, and the created_at tiebreak in
    // the list query keeps the order stable either way.
    const next = await prisma.deal_inspection_items.aggregate({
      _max: { sort_order: true },
      where: { deal_id: dealId },
    });

    const item = await prisma.deal_inspection_items.create({
      data: {
        deal_id: dealId,
        document_id: documentId,
        sort_order: (next._max.sort_order ?? -1) + 1,
        category: (body.category ?? "").trim() || "General",
        description,
        severity: severity as InspectionItemSeverity,
        owner: owner as InspectionItemOwner,
        notes: body.notes?.trim() || null,
      },
      select: ITEM_SELECT,
    });
    return json(item);
  })) as Response;
}
