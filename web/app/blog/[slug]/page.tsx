import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPostBySlug } from "@/lib/notion";
import { prepareScopedPost, POST_SCOPE } from "@/lib/blog-html";
import BlogShell from "@/components/blog/BlogShell";

const SITE = "RealTourFlow";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPostBySlug(SITE, slug);
  if (!post) return { title: "Post not found — RealTourFlow" };
  const canonical = `https://www.realtourflow.com/blog/${slug}`;
  // Falls back to the site logo so OG/Twitter cards always carry an image,
  // even for posts with no Notion cover set.
  const ogImage = post.meta.coverUrl ?? "https://www.realtourflow.com/logo.png";
  return {
    title: `${post.meta.title} — RealTourFlow`,
    description: post.meta.excerpt || undefined,
    alternates: { canonical },
    openGraph: {
      title: post.meta.title,
      description: post.meta.excerpt || undefined,
      images: [ogImage],
      type: "article",
      url: canonical,
      publishedTime: post.meta.date ?? undefined,
    },
    twitter: {
      card: "summary_large_image",
      title: post.meta.title,
      description: post.meta.excerpt || undefined,
      images: [ogImage],
    },
  };
}

export default async function BlogPost({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = await getPostBySlug(SITE, slug);
  if (!post) notFound();

  // The post body is a full HTML document stored in Notion. Extract its body,
  // styles, and font links and inject them, with the CSS scoped to `.rtf-post`
  // so it can't collide with the site's global styles. The post controls its own
  // width (its internal .wrap/.wide), so the injected container is full-width.
  const { css, bodyHtml, headLinks, jsonLd } = prepareScopedPost(post.html);

  return (
    <BlogShell>
      {jsonLd.map((json, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />
      ))}

      <div style={{ maxWidth: 720, margin: "0 auto", padding: "28px 24px 0" }}>
        <Link
          href="/blog"
          style={{ fontSize: 14, fontWeight: 500, color: "#4b5563", textDecoration: "none" }}
        >
          ← All posts
        </Link>
      </div>

      {headLinks && <div dangerouslySetInnerHTML={{ __html: headLinks }} />}
      {css && <style dangerouslySetInnerHTML={{ __html: css }} />}

      {bodyHtml ? (
        <div className={POST_SCOPE} dangerouslySetInnerHTML={{ __html: bodyHtml }} />
      ) : (
        <div style={{ maxWidth: 720, margin: "0 auto", padding: "24px" }}>
          <p style={{ fontSize: 16, color: "#6b7280" }}>
            This post doesn&rsquo;t have any content yet.
          </p>
        </div>
      )}
    </BlogShell>
  );
}
