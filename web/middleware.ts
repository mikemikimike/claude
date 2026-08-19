import { NextRequest, NextResponse } from "next/server";

const MARKETING_HOSTS = new Set(["realtourflow.com", "www.realtourflow.com"]);

// Marketing pages that live on the root domain (not the app). Served on the
// marketing host; kept canonical there (redirected off the app host).
function isBlogPath(pathname: string): boolean {
  return pathname === "/blog" || pathname.startsWith("/blog/");
}

// Standalone marketing feature pages (linked from blog posts / landing page).
function isFeaturePath(pathname: string): boolean {
  return pathname === "/features" || pathname.startsWith("/features/");
}

// IndexNow ownership key — must be publicly reachable at this path so Bing/Yandex
// can verify URL submissions (web/public/<key>.txt).
const INDEXNOW_KEY_FILE = "/9f2c7a14e0b84d3596af1c6e8b2705d3.txt";

// SEO/verification files that must be served (not redirected) on the marketing host.
function isSeoFile(pathname: string): boolean {
  return (
    pathname === "/sitemap.xml" ||
    pathname === "/robots.txt" ||
    pathname === INDEXNOW_KEY_FILE
  );
}

export function middleware(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  const { pathname } = req.nextUrl;

  if (MARKETING_HOSTS.has(host)) {
    // API routes called by the landing page form pass through as-is.
    if (pathname.startsWith("/api/")) {
      return NextResponse.next();
    }
    // Rewrite / → /landing internally. Browser URL stays clean.
    if (pathname === "/") {
      return NextResponse.rewrite(new URL("/landing", req.url));
    }
    // The blog, feature pages, + SEO/verification files live on the marketing
    // domain — serve them.
    if (isBlogPath(pathname) || isFeaturePath(pathname) || isSeoFile(pathname)) {
      return NextResponse.next();
    }
    // Any other path on the marketing domain (e.g. /agent, /buyer) → send
    // to the real app so deep links still work.
    return NextResponse.redirect(
      new URL(
        `https://app.realtourflow.com${pathname}${req.nextUrl.search}`,
        req.url
      ),
      301
    );
  }

  // On the explicit app domain, keep marketing-only pages canonical on the root
  // domain. localhost passes through so both can be previewed locally.
  if (host === "app.realtourflow.com") {
    // /landing is internal — block direct access.
    if (pathname === "/landing" || pathname.startsWith("/landing/")) {
      return NextResponse.redirect(new URL("/", req.url));
    }
    // The blog + feature pages belong on the marketing site — redirect there.
    if (isBlogPath(pathname) || isFeaturePath(pathname)) {
      return NextResponse.redirect(
        new URL(
          `https://www.realtourflow.com${pathname}${req.nextUrl.search}`,
          req.url
        ),
        301
      );
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Run on all paths except Next.js internals and static files.
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
