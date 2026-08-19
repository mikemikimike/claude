import type { Metadata } from "next";
import Link from "next/link";
import BlogShell from "@/components/blog/BlogShell";

const S = {
  navy: "#00163b",
  gold: "#d6bf8d",
  white: "#ffffff",
  border: "#e5e7eb",
  textSecondary: "#4b5563",
};

export const metadata: Metadata = {
  title: "Client Portal for Buyers & Sellers — RealTourFlow",
  description:
    "A clean window into progress, next steps, and documents for every buyer and seller — so clients stop texting \"any update?\" and start checking the portal.",
  alternates: { canonical: "https://www.realtourflow.com/features/client-portal" },
  openGraph: {
    title: "Client Portal for Buyers & Sellers",
    description:
      "A clean window into progress, next steps, and documents for every buyer and seller.",
    url: "https://www.realtourflow.com/features/client-portal",
    type: "website",
  },
};

const FEATURES = [
  {
    title: "Live progress, not a status text",
    body: "Buyers and sellers see their deal's current stage, what's next, and who's waiting on what — without pinging you for it.",
  },
  {
    title: "Documents in one place",
    body: "Disclosures, signed forms, and uploads live in the same portal the client already checks, so nothing gets buried in email.",
  },
  {
    title: "Updates arrive before the question does",
    body: "The moment a stage advances or a task closes, the client sees it. The \"any update?\" text stops because you already answered it.",
  },
];

export default function ClientPortalFeaturePage() {
  return (
    <BlogShell>
      <section style={{ maxWidth: 820, margin: "0 auto", padding: "64px 24px 24px" }}>
        <p
          style={{
            fontFamily: "monospace",
            fontSize: 12,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: S.gold,
            fontWeight: 700,
            margin: "0 0 14px",
          }}
        >
          Feature
        </p>
        <h1
          style={{
            fontSize: "clamp(32px, 5vw, 44px)",
            fontWeight: 700,
            color: S.navy,
            letterSpacing: "-0.025em",
            margin: "0 0 16px",
            lineHeight: 1.1,
          }}
        >
          Every client updated, without you writing the update
        </h1>
        <p style={{ fontSize: 18, color: S.textSecondary, lineHeight: 1.7, margin: "0 0 32px" }}>
          Buyers and sellers get their own client portal — live progress, next steps, and
          documents — so you look on top of the deal because you are, and your phone stops
          buzzing.
        </p>
        <a
          href="https://www.realtourflow.com/#capture"
          style={{
            display: "inline-block",
            background: S.navy,
            color: S.white,
            fontWeight: 600,
            fontSize: 16,
            textDecoration: "none",
            padding: "14px 26px",
            borderRadius: 10,
          }}
        >
          Join the founding-agent waitlist
        </a>
      </section>

      <section style={{ maxWidth: 820, margin: "0 auto", padding: "8px 24px 64px" }}>
        {FEATURES.map((f) => (
          <div
            key={f.title}
            style={{
              background: S.white,
              border: `1px solid ${S.border}`,
              borderRadius: 14,
              padding: "24px 26px",
              marginBottom: 16,
            }}
          >
            <h2 style={{ fontSize: 20, fontWeight: 700, color: S.navy, margin: "0 0 8px" }}>
              {f.title}
            </h2>
            <p style={{ fontSize: 16, color: S.textSecondary, lineHeight: 1.65, margin: 0 }}>
              {f.body}
            </p>
          </div>
        ))}

        <p style={{ fontSize: 16, color: S.textSecondary, lineHeight: 1.7, marginTop: 32 }}>
          Part of the{" "}
          <Link href="/features/pipeline" style={{ color: S.navy, fontWeight: 600 }}>
            deal command center
          </Link>
          . For the full breakdown of what a transaction takes from contract to close, read{" "}
          <Link href="/blog/real-estate-transaction-management" style={{ color: S.navy, fontWeight: 600 }}>
            the complete guide to real estate transaction management
          </Link>
          .
        </p>
      </section>
    </BlogShell>
  );
}
