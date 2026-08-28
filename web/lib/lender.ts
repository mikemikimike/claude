/**
 * Mountain Mortgage hand-off constants (#435, epic #441).
 *
 * The lender hand-off is hardcoded to Mountain Mortgage for v1 — a second
 * lender is a possible future, but nothing here is configurable yet. Every
 * surface that points a buyer at the application or at the loan officer reads
 * these, so swapping the lender is a one-line change in ONE file rather than a
 * grep for a phone number across the portal.
 *
 * Client-safe on purpose: no server imports, so a client component can pull it
 * in without dragging Prisma into the browser bundle.
 */

/**
 * The 1003 application.
 *
 * Verified working 2026-08-28 (#431). Two things about this string are
 * load-bearing:
 *   - `/2233772/` is Paul's NMLS number. It is what makes the page render his
 *     advisor card and attribute the application to him. The site redirects to
 *     the bare domain after load — do NOT "simplify" the URL to match what the
 *     address bar ends up showing.
 *   - There is deliberately no `?time=…` query param. The one that used to be
 *     pasted around (`time=1755484352205`) is stale copy-paste residue; the
 *     page is byte-identical with and without it.
 *
 * The form prefills nothing — a buyer retypes their name and email. Don't write
 * copy that promises otherwise.
 */
export const MOUNTAIN_MORTGAGE_APPLICATION_URL =
  "https://mountainmortgage-paul.my1003app.com/2233772/register";

/** Loan officer a buyer reaches on the number below. */
export const MOUNTAIN_MORTGAGE_LOAN_OFFICER = "Paul Leara";

/** Human-readable, for display in copy. */
export const MOUNTAIN_MORTGAGE_PHONE_DISPLAY = "(205) 401-9076";

/** E.164, for `tel:` hrefs — dialers are happier with it than with punctuation. */
export const MOUNTAIN_MORTGAGE_PHONE_E164 = "+12054019076";

/** Ready-made `tel:` href so no caller has to remember to prefix it. */
export const MOUNTAIN_MORTGAGE_PHONE_HREF = `tel:${MOUNTAIN_MORTGAGE_PHONE_E164}`;
