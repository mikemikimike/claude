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
  title: "Auto-Calculated Tasks & Deadlines — RealTourFlow",
  description:
    "Every deadline in the contract, calculated the moment a deal advances stages — inspection, financing, appraisal, closing — so nothing depends on you remembering it.",
  alternates: { canonical: "https://www.realtourflow.com/features/auto-tasks-deadlines" },
  openGraph: {
    title: "Auto-Calculated Tasks & Deadlines",
    description:
      "Every deadline in the contract, calculated the moment a deal advances stages, so nothing depends on you remembering it.",
    url: "https://www.realtourflow.com/features/auto-tasks-deadlines",
    type: "website",
  },
};

const FEATURES = [
  {
    title: "Deadlines calculated on day zero",
    body: "The moment a deal moves to under contract, RealTourFlow works out every date that matters from the effective date — no manual calendaring.",
  },
  {
    title: "Tasks fire on stage advance",
    body: "Move a deal forward and its stage's default checklist loads automatically — order the appraisal, send disclosures, confirm the walkthrough.",
  },
  {
    title: "Nothing depends on memory",
    body: "Alerts land days ahead of a deadline, not on it, so a slow lender or a late inspection response doesn't quietly become a lost deal.",
  },
];

export default function AutoTasksFeaturePage() {
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
          Every deadline calculated automatically
        </h1>
        <p style={{ fontSize: 18, color: S.textSecondary, lineHeight: 1.7, margin: "0 0 32px" }}>
          Inspection, financing, appraisal, closing — the deadlines that actually kill deals get
          set the second a contract is executed, and the tasks behind them load themselves as the
          deal moves forward.
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
          See how this fits into the rest of the deal in{" "}
          <Link href="/blog/real-estate-transaction-management" style={{ color: S.navy, fontWeight: 600 }}>
            the complete guide to real estate transaction management
          </Link>
          , or check out the{" "}
          <Link href="/features/pipeline" style={{ color: S.navy, fontWeight: 600 }}>
            deal command center
          </Link>
          .
        </p>
      </section>
    </BlogShell>
  );
}
