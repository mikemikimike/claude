import type { Metadata } from "next";
import Link from "next/link";
import BlogShell from "@/components/blog/BlogShell";

const S = {
  navy: "#00163b",
  gold: "#d6bf8d",
  bg: "#f8f6f3",
  white: "#ffffff",
  border: "#e5e7eb",
  text: "#1f2937",
  textSecondary: "#4b5563",
};

export const metadata: Metadata = {
  title: "The Deal Command Center for Real Estate Agents — RealTourFlow",
  description:
    "One screen for every buyer and seller deal you're running — stage, tasks, documents, and client updates, all in one pipeline.",
  alternates: { canonical: "https://www.realtourflow.com/features/pipeline" },
  openGraph: {
    title: "The Deal Command Center for Real Estate Agents",
    description:
      "One screen for every buyer and seller deal you're running — stage, tasks, documents, and client updates, all in one pipeline.",
    url: "https://www.realtourflow.com/features/pipeline",
    type: "website",
  },
};

const FEATURES = [
  {
    title: "Every deal, one screen",
    body: "Buyer and seller files parked at their exact stage — intake through post-close — so you never have to reconstruct where things stand from memory.",
  },
  {
    title: "Stage advances drive the file",
    body: "Move a deal to the next stage and its tasks, deadlines, and default checklist load automatically. See how in the auto-tasks & deadlines breakdown.",
  },
  {
    title: "Built for the individual agent",
    body: "No per-seat licensing, no brokerage back-office you don't need. You pay $75 per closing, only when the deal actually closes.",
  },
];

export default function PipelineFeaturePage() {
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
          The deal command center for real estate agents
        </h1>
        <p style={{ fontSize: 18, color: S.textSecondary, lineHeight: 1.7, margin: "0 0 32px" }}>
          RealTourFlow puts every active buyer and seller deal on one screen — the stage it&rsquo;s
          at, what&rsquo;s due next, and who needs to hear from you. No more running your pipeline
          out of your texts, inbox, and memory.
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
          Want the full picture of what running a transaction actually takes? Read{" "}
          <Link href="/blog/real-estate-transaction-management" style={{ color: S.navy, fontWeight: 600 }}>
            the complete guide to real estate transaction management
          </Link>
          .
        </p>
      </section>
    </BlogShell>
  );
}
