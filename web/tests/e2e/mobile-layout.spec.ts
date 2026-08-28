import { test, expect, type Page } from "@playwright/test";
import { seedSession } from "./helpers/session";

/**
 * Mobile-responsive layout E2E (#86 / T18). The agent shell was desktop-only
 * (a fixed w-56 sidebar inside h-screen overflow-hidden); on a phone the sidebar
 * ate most of the screen. This proves the golden path runs on a 390px viewport:
 * the nav collapses to a hamburger drawer and Pipeline/DealDetail never scroll
 * horizontally.
 */

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

// `max-w-lg` — the width the client portals used to be pinned to at EVERY
// viewport (#421). Desktop must beat it; mobile must stay inside it.
const MAX_W_LG = 512;

// Assert the document never extends past the viewport width (allowing 1px of
// sub-pixel rounding). A failure means something forces horizontal scroll.
async function expectNoHorizontalOverflow(page: Page, where: string) {
  const { scrollWidth, inner } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  expect(
    scrollWidth,
    `horizontal overflow on ${where}: scrollWidth ${scrollWidth} > viewport ${inner}`
  ).toBeLessThanOrEqual(inner + 1);
}

test.describe("mobile agent layout (390px)", () => {
  test.use({ viewport: MOBILE });

  test("golden path runs on a phone via the hamburger drawer, no horizontal scroll", async ({
    page,
  }) => {
    await seedSession(page, { role: "agent", name: "E2E Mobile Agent" });

    // 1. Dashboard — the hamburger replaces the sidebar; no overflow.
    await page.goto("/agent");
    const hamburger = page.getByRole("button", { name: "Open navigation" });
    await expect(hamburger).toBeVisible();
    await expectNoHorizontalOverflow(page, "dashboard");

    // 2. The drawer opens, navigates, and slides away after navigation. The
    //    panel stays in the DOM (translated), so assert its on/off-screen
    //    position rather than visibility.
    const drawer = page.getByRole("dialog", { name: "Navigation menu" });
    await hamburger.click();
    await expect
      .poll(async () => (await drawer.boundingBox())?.x ?? -999)
      .toBeGreaterThanOrEqual(0);

    await drawer.getByRole("link", { name: "Pipeline" }).click();
    await expect(page).toHaveURL(/\/agent\/pipeline/);
    await expect
      .poll(async () => (await drawer.boundingBox())?.x ?? -999)
      .toBeLessThan(0);
    await expectNoHorizontalOverflow(page, "pipeline");

    // 3. Create a deal through the (full-width) New Deal modal.
    const clientName = `E2E Mobile ${Date.now()}`;
    await page.getByRole("button", { name: "New Deal" }).click();
    await page.getByPlaceholder("e.g. Jane Doe").fill(clientName);
    await page.getByPlaceholder("350,000").fill("425,000");
    await expectNoHorizontalOverflow(page, "new-deal modal");
    await page.getByRole("button", { name: "Create Deal" }).click();
    await expect(page.getByText("Deal Created")).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();

    // 4. Open the deal and advance the stage — DealDetail must not overflow.
    const card = page.getByRole("link").filter({ hasText: clientName });
    await expect(card).toBeVisible();
    await card.click();
    await expect(page).toHaveURL(/\/agent\/deals\//);
    await expectNoHorizontalOverflow(page, "deal detail");

    await page.getByRole("button", { name: "Active Search" }).click();
    await page.getByRole("button", { name: "Confirm & Advance" }).click();
    await expect(page.getByRole("button", { name: "Offer Active" })).toBeVisible();
    await expectNoHorizontalOverflow(page, "deal detail after advance");
  });
});

// ─── Client portal responsive width (#421) ───────────────────────────────────
//
// Both client portals were pinned to `mx-auto max-w-lg` with no breakpoint
// override, so a buyer on a 1440px monitor got a 512px phone-shaped strip.
// These cover both ends: the portal must use the room on a desktop, and must
// still be one stacked column on a phone.

type PortalFixture = { userId: string; dealId: string };

/**
 * Stand up a real portal: an agent, a deal they own, and a buyer/seller
 * participant whose seeded session is left in the browser context. Everything
 * goes through the public API with an explicit agent bearer token, so the
 * cookie the page ends up with is the client's.
 */
async function seedPortalDeal(
  page: Page,
  kind: "buy" | "sell"
): Promise<PortalFixture> {
  const role = kind === "buy" ? "buyer" : "seller";
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const agentRes = await page.request.post("/api/test-auth", {
    data: {
      role: "agent",
      sub: `e2e|portal-agent-${stamp}`,
      name: "E2E Portal Agent",
    },
  });
  if (!agentRes.ok()) {
    throw new Error(`seed agent failed: ${agentRes.status()} ${await agentRes.text()}`);
  }
  const agent = (await agentRes.json()) as { token: string };
  const auth = { Authorization: `Bearer ${agent.token}` };

  const dealRes = await page.request.post("/api/deals", {
    headers: auth,
    data: {
      title: `E2E Portal ${stamp}`,
      type: kind,
      address: "742 Evergreen Terrace",
      price: "425000",
    },
  });
  if (!dealRes.ok()) {
    throw new Error(`create deal failed: ${dealRes.status()} ${await dealRes.text()}`);
  }
  const deal = (await dealRes.json()) as { id: string };

  // Seeded last so the browser context carries the CLIENT's session cookie.
  const client = await seedSession(page, {
    role,
    sub: `e2e|portal-${role}-${stamp}`,
    name: `E2E Portal ${role === "buyer" ? "Buyer" : "Seller"}`,
  });

  const partRes = await page.request.post(`/api/deals/${deal.id}/participants`, {
    headers: auth,
    data: { email: client.email, role },
  });
  if (!partRes.ok()) {
    throw new Error(
      `add participant failed: ${partRes.status()} ${await partRes.text()}`
    );
  }

  return { userId: client.id, dealId: deal.id };
}

async function openPortal(page: Page, kind: "buy" | "sell") {
  const { userId } = await seedPortalDeal(page, kind);
  await page.goto(`/${kind === "buy" ? "buyer" : "seller"}/${userId}`);
  const root = page.getByTestId("portal-root");
  await expect(root).toBeVisible();
  return root;
}

for (const kind of ["buy", "sell"] as const) {
  const label = kind === "buy" ? "buyer" : "seller";

  test.describe(`${label} portal on desktop (1440px)`, () => {
    test.use({ viewport: DESKTOP });

    test(`${label} portal grows past the 512px column and sits in two columns`, async ({
      page,
    }) => {
      const root = await openPortal(page, kind);

      const rootBox = await root.boundingBox();
      expect(rootBox, "portal root has no layout box").not.toBeNull();
      expect(
        rootBox!.width,
        `${label} portal is still pinned to a ${MAX_W_LG}px column on a 1440px viewport`
      ).toBeGreaterThan(MAX_W_LG);

      // The stacked sections spread sideways above `lg` rather than running
      // one long strip down the page.
      const primary = (await page.getByTestId("portal-primary").boundingBox())!;
      const secondary = (await page.getByTestId("portal-secondary").boundingBox())!;
      expect(secondary.x, "secondary column is not beside the primary one").toBeGreaterThan(
        primary.x
      );
      expect(
        secondary.y,
        "secondary column starts below the primary column — still stacked"
      ).toBeLessThan(primary.y + primary.height);

      await expectNoHorizontalOverflow(page, `${label} portal @1440`);
    });
  });

  test.describe(`${label} portal on a phone (390px, unchanged)`, () => {
    test.use({ viewport: MOBILE });

    test(`${label} portal stays one narrow column with no horizontal scroll`, async ({
      page,
    }) => {
      const root = await openPortal(page, kind);

      const rootBox = (await root.boundingBox())!;
      expect(
        rootBox.width,
        `${label} portal widened on mobile — the phone layout must not change`
      ).toBeLessThanOrEqual(MAX_W_LG);

      const primary = (await page.getByTestId("portal-primary").boundingBox())!;
      const secondary = (await page.getByTestId("portal-secondary").boundingBox())!;
      expect(secondary.x, "columns went side-by-side on a phone").toBeCloseTo(primary.x, 0);
      expect(
        secondary.y,
        "secondary section is not stacked under the primary one on a phone"
      ).toBeGreaterThanOrEqual(primary.y + primary.height);

      await expectNoHorizontalOverflow(page, `${label} portal @390`);
    });
  });
}

test.describe("desktop agent layout (unchanged)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("keeps the persistent sidebar and hides the hamburger", async ({ page }) => {
    await seedSession(page, { role: "agent", name: "E2E Desktop Agent" });
    await page.goto("/agent");

    // The persistent sidebar nav is visible; the mobile hamburger is not.
    await expect(
      page.getByRole("complementary").getByRole("link", { name: "Pipeline" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Open navigation" })
    ).toBeHidden();
  });
});
