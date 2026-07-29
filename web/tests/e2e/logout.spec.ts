import { test, expect } from "@playwright/test";
import { seedSession } from "./helpers/session";

/**
 * Logout E2E: until UserMenu shipped there was no way to sign out of the app at
 * all, for any role. Covers both menu variants — the white dashboard bar (agent)
 * and the navy client header (buyer).
 *
 * What we assert: the session cookie is gone and the role's shell is no longer
 * rendered. NOT the text on the resulting page — in E2E mode Providers renders
 * no Auth0Provider, so useAuth0() returns the library's initialContext whose
 * `isLoading` stays true forever and RootRedirect renders null. A blank page
 * after logout is correct here; in production Auth0 redirects instead.
 */
const COOKIE = "rtf_e2e_session";

async function logOut(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Log out" }).click();
}

test("agent can log out from the dashboard top bar", async ({ page }) => {
  await seedSession(page, { role: "agent", name: "E2E Agent" });

  await page.goto("/agent");
  // Scoped to the sidebar — the dashboard body links to Pipeline too.
  const sidebarPipeline = page
    .getByRole("navigation")
    .getByRole("link", { name: "Pipeline" });
  await expect(sidebarPipeline).toBeVisible();

  await logOut(page);

  await expect
    .poll(async () =>
      (await page.context().cookies()).some((c) => c.name === COOKIE)
    )
    .toBe(false);
  await expect(sidebarPipeline).toBeHidden();
});

test("buyer can log out from the client header", async ({ page }) => {
  const session = await seedSession(page, { role: "buyer", name: "E2E Buyer" });

  await page.goto(`/buyer/${session.id}`);
  // The navy client header renders the dark UserMenu variant.
  const trigger = page.getByRole("button", { name: "Account menu" });
  await expect(trigger).toBeVisible();

  await logOut(page);

  await expect
    .poll(async () =>
      (await page.context().cookies()).some((c) => c.name === COOKIE)
    )
    .toBe(false);
  await expect(trigger).toBeHidden();
});

test("logging out clears a pending invite token so the next account can't claim it", async ({
  page,
}) => {
  await seedSession(page, { role: "agent", name: "E2E Agent" });
  await page.goto("/agent");
  await page.evaluate(() => {
    localStorage.setItem("pendingInvite", "leftover-token");
    localStorage.setItem("pendingInviteEmail", "someone-else@example.com");
  });

  await logOut(page);

  await expect
    .poll(async () => page.evaluate(() => localStorage.getItem("pendingInvite")))
    .toBeNull();
  expect(
    await page.evaluate(() => localStorage.getItem("pendingInviteEmail"))
  ).toBeNull();
});
