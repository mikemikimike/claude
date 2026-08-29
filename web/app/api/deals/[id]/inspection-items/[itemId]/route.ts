import { error, json, withAuth } from "@/lib/http";
import { prisma } from "@/lib/db";
import { resolveUserId } from "@/lib/users";
import {
  INSPECTION_ITEM_OWNERS,
  INSPECTION_ITEM_SEVERITIES,
  INSPECTION_ITEM_STATUSES,
  isClosedInspectionStatus,
  type InspectionItemOwner,
  type InspectionItemSeverity,
  type InspectionItemStatus,
} from "@/lib/inspection-items";
import { inspectionItemAccess } from "@/lib/inspection-item-access";

type Ctx = { params: Promise<{ id: string; itemId: string }> };

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

type PatchBody = {
  description?: string;
  category?: string;
  severity?: string;
  status?: string;
  owner?: string;
  notes?: string | null;
  sort_order?: number;
};

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const { id: dealId, itemId } = await ctx.params;
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);
    const access = await inspectionItemAccess(dealId, userId, claims.roles);
    if (!access.canRead) return error("deal not found", 404);
    if (!access.canWrite) return error("read-only access to this deal", 403);

    let body: PatchBody;
    try {
      body = (await req.json()) as PatchBody;
    } catch {
      return error("invalid body", 400);
    }

    const data: {
      description?: string;
      category?: string;
      severity?: InspectionItemSeverity;
      status?: InspectionItemStatus;
      owner?: InspectionItemOwner;
      notes?: string | null;
      sort_order?: number;
      resolved_at?: Date | null;
      updated_at: Date;
    } = { updated_at: new Date() };

    if (body.description !== undefined) {
      const description = body.description.trim();
      if (!description) return error("description cannot be empty", 400);
      data.description = description;
    }
    if (body.category !== undefined) {
      data.category = body.category.trim() || "General";
    }
    if (body.severity !== undefined) {
      if (!(INSPECTION_ITEM_SEVERITIES as readonly string[]).includes(body.severity)) {
        return error("invalid severity", 400);
      }
      data.severity = body.severity as InspectionItemSeverity;
    }
    if (body.owner !== undefined) {
      if (!(INSPECTION_ITEM_OWNERS as readonly string[]).includes(body.owner)) {
        return error("invalid owner", 400);
      }
      data.owner = body.owner as InspectionItemOwner;
    }
    if (body.status !== undefined) {
      if (!(INSPECTION_ITEM_STATUSES as readonly string[]).includes(body.status)) {
        return error("invalid status", 400);
      }
      data.status = body.status as InspectionItemStatus;
      // resolved_at is derived from status, never sent by the client, so the
      // two can't drift. Reopening an item clears the stamp — otherwise a
      // reopened item still looks closed to anything counting resolved_at.
      data.resolved_at = isClosedInspectionStatus(body.status) ? new Date() : null;
    }
    if (body.notes !== undefined) {
      data.notes = body.notes === null ? null : body.notes.trim() || null;
    }
    if (body.sort_order !== undefined) {
      if (!Number.isInteger(body.sort_order)) {
        return error("invalid sort_order", 400);
      }
      data.sort_order = body.sort_order;
    }

    // Scoped by deal_id as well as id: an item id from another deal must not be
    // reachable through a deal this caller happens to own.
    const updated = await prisma.deal_inspection_items.updateMany({
      where: { id: itemId, deal_id: dealId },
      data,
    });
    if (updated.count === 0) return error("item not found", 404);

    const item = await prisma.deal_inspection_items.findUnique({
      where: { id: itemId },
      select: ITEM_SELECT,
    });
    if (!item) return error("item not found", 404);
    return json(item);
  })) as Response;
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const { id: dealId, itemId } = await ctx.params;
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);
    const access = await inspectionItemAccess(dealId, userId, claims.roles);
    if (!access.canRead) return error("deal not found", 404);
    if (!access.canWrite) return error("read-only access to this deal", 403);

    await prisma.deal_inspection_items.deleteMany({
      where: { id: itemId, deal_id: dealId },
    });
    return json({ status: "ok" });
  })) as Response;
}
