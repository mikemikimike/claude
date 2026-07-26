/**
 * POST /deals/:dealId/properties/:propId/analyze-photos — run a Claude-vision
 * pass over a tracked property's listing photos and store the result (#375).
 *
 * OWNING AGENT ONLY. The analysis contains condition/defect judgments that must
 * never reach the buyer/seller portals — same stance as comps (#374). Buyers /
 * other agents get the same 404 as a stranger. The stored blob is additionally
 * stripped from the property serializer for non-owners (see properties/route.ts).
 *
 * Photos come from the request body (`photo_urls[]` — the agent's MLS search
 * already has them), falling back to the property's stored thumbnail. At most
 * MAX_PHOTOS are analyzed; org-level spend caps are #377's job.
 *
 * Synchronous for v1: one Opus vision call over ≤6 images finishes well within
 * the function timeout, and the agent wants the result inline.
 */
import { error, json, withAuth } from "@/lib/http";
import { prisma } from "@/lib/db";
import { resolveUserId } from "@/lib/users";
import {
  analyzePhotos,
  isPhotoAnalysisEnabled,
  selectPhotoUrls,
  PhotoAnalysisError,
  PhotoAnalysisNotConfiguredError,
  type PhotoAnalysisSubject,
} from "@/lib/photo-analysis";

type Ctx = { params: Promise<{ id: string; propId: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = { photo_urls?: unknown };

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { id: dealId, propId } = await ctx.params;
  return (await withAuth(req, async (claims): Promise<Response> => {
    // Cost gate (#377): the feature is parked and disabled by default, so no
    // work (and no paid model call) happens unless it's explicitly enabled.
    if (!isPhotoAnalysisEnabled()) {
      return error("photo analysis is disabled", 503);
    }

    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);
    if (!UUID_RE.test(dealId) || !UUID_RE.test(propId)) {
      return error("deal not found", 404);
    }

    // Owning agent only — participants get a bare 404, never confirming the
    // deal exists to a buyer.
    const deal = await prisma.deals.findFirst({
      where: { id: dealId, agent_id: userId },
      select: { id: true },
    });
    if (!deal) return error("deal not found", 404);

    const property = await prisma.tracked_properties.findFirst({
      where: { id: propId, deal_id: dealId },
      select: {
        id: true,
        address: true,
        city: true,
        beds: true,
        baths: true,
        sqft: true,
        thumbnail_url: true,
      },
    });
    if (!property) return error("property not found", 404);

    let body: Body = {};
    try {
      body = (await req.json()) as Body;
    } catch {
      // Empty/omitted body is fine — we fall back to the thumbnail.
      body = {};
    }

    const suppliedUrls = Array.isArray(body.photo_urls) ? body.photo_urls : undefined;
    const photoUrls = selectPhotoUrls(suppliedUrls, property.thumbnail_url);
    if (photoUrls.length === 0) {
      return error("no photos to analyze (send photo_urls or set a thumbnail)", 422);
    }

    const subject: PhotoAnalysisSubject = {
      address: property.address,
      city: property.city,
      beds: Number(property.beds),
      baths: Number(property.baths),
      sqft: property.sqft,
    };

    let analysis;
    try {
      analysis = await analyzePhotos(photoUrls, subject);
    } catch (e) {
      if (e instanceof PhotoAnalysisNotConfiguredError) {
        return error("photo analysis is not configured", 503);
      }
      if (e instanceof PhotoAnalysisError) {
        return error(e.message, 502);
      }
      // Network/timeout/etc. from the model call — an upstream failure.
      const msg = e instanceof Error ? e.message : String(e);
      return error(msg, 502);
    }

    await prisma.tracked_properties.update({
      where: { id: propId },
      data: { photo_analysis: analysis },
    });

    return json({ analysis });
  })) as Response;
}
