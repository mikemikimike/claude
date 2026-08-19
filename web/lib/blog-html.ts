/**
 * Publishes a full HTML document (authored in chat, stored in a Notion code
 * block) inside the templated blog page. We pull the document's <style> + <body>,
 * drop <script> tags, and scope every CSS selector to a wrapper class so a post's
 * styles can't leak into — or get clobbered by — the site's global CSS.
 *
 * The site renders posts inside a shared shell (nav/footer), so posts are stored
 * as full documents and we inject the scoped body + styles. Scoping is best-effort
 * for ordinary post CSS (selectors, @media/@supports groups, keyframes/font-face
 * pass through); author posts as self-contained, class/element-styled documents.
 */

export const POST_SCOPE = "rtf-post";

export type PreparedPost = { css: string; bodyHtml: string; headLinks: string; jsonLd: string[] };

/** Extract + scope a stored HTML document for injection under `.<scope>`. */
export function prepareScopedPost(htmlDoc: string, scope: string = POST_SCOPE): PreparedPost {
  const { styles, bodyHtml, links, jsonLd } = extractStyleAndBody(htmlDoc);
  const css = styles.map((s) => scopeCss(s, `.${scope}`)).join("\n");
  return {
    css,
    bodyHtml,
    headLinks: links.join("\n"),
    jsonLd: jsonLd.map(sanitizeJsonLd).filter((s): s is string => s !== null),
  };
}

/** Re-serialize as trusted JSON, escaping `<` so a string value can't break out of the <script> tag it's rendered in. Drops anything that doesn't parse. */
function sanitizeJsonLd(raw: string): string | null {
  try {
    return JSON.stringify(JSON.parse(raw)).replace(/</g, "\\u003c");
  } catch {
    return null;
  }
}

export function extractStyleAndBody(htmlDoc: string): {
  styles: string[];
  bodyHtml: string;
  links: string[];
  jsonLd: string[];
} {
  let doc = htmlDoc ?? "";

  // Pull JSON-LD structured-data blocks out before stripping scripts — this is
  // inert data the page re-renders itself (see sanitizeJsonLd), not markup the
  // author's script tag needs to execute.
  const jsonLd: string[] = [];
  const ldRe = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ld: RegExpExecArray | null;
  while ((ld = ldRe.exec(doc)) !== null) jsonLd.push(ld[1]);

  // Scripts won't execute via innerHTML anyway — strip them from the markup.
  doc = doc.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");

  const styles: string[] = [];
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m: RegExpExecArray | null;
  while ((m = styleRe.exec(doc)) !== null) styles.push(m[1]);

  // Keep font/resource <link>s (e.g. Google Fonts) from the <head> — otherwise
  // the post falls back to system fonts. Only stylesheet/preconnect/dns-prefetch;
  // canonical + icon are owned by the page's own metadata.
  const links: string[] = [];
  const linkRe = /<link\b[^>]*>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(doc)) !== null) {
    if (/rel=["'](?:stylesheet|preconnect|dns-prefetch)["']/i.test(lm[0])) links.push(lm[0]);
  }

  // Prefer <body> inner HTML; otherwise strip the document scaffolding.
  const bodyMatch = doc.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  let bodyHtml = bodyMatch
    ? bodyMatch[1]
    : doc
        .replace(/<!doctype[^>]*>/gi, "")
        .replace(/<\/?html\b[^>]*>/gi, "")
        .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, "");

  // The <style> blocks are rendered separately — remove them from the body.
  bodyHtml = bodyHtml.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "").trim();
  return { styles, bodyHtml, links, jsonLd };
}

/** Prefix every selector in `css` with `scope` so its rules only apply inside it. */
export function scopeCss(css: string, scope: string): string {
  return scopeBlock(stripComments(css), scope);
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// Group at-rules: keep the wrapper, scope the selectors nested inside.
const GROUP_AT = /^@(media|supports|container|layer)\b/i;
// Pass-through at-rules: their "selectors" aren't element selectors.
const PASSTHRU_AT =
  /^@(keyframes|-webkit-keyframes|font-face|page|font-feature-values|counter-style|property|charset|import|namespace)\b/i;

function scopeBlock(css: string, scope: string): string {
  let out = "";
  let i = 0;
  const n = css.length;

  while (i < n) {
    // Carry leading whitespace through unchanged.
    const wsStart = i;
    while (i < n && /\s/.test(css[i])) i++;
    out += css.slice(wsStart, i);
    if (i >= n) break;

    // Read the prelude up to a top-level '{' or ';', skipping quoted strings.
    let prelude = "";
    let quote: string | null = null;
    while (i < n) {
      const c = css[i];
      if (quote) {
        prelude += c;
        if (c === quote && css[i - 1] !== "\\") quote = null;
        i++;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        prelude += c;
        i++;
        continue;
      }
      if (c === "{" || c === ";") break;
      prelude += c;
      i++;
    }

    if (i < n && css[i] === ";") {
      // At-statement (e.g. @import "x";) — keep verbatim.
      out += prelude + ";";
      i++;
      continue;
    }
    if (i >= n) {
      out += prelude;
      break;
    }

    // css[i] === '{' — capture the matching block (string-aware).
    i++;
    let depth = 1;
    let body = "";
    quote = null;
    while (i < n && depth > 0) {
      const c = css[i];
      if (quote) {
        if (c === quote && css[i - 1] !== "\\") quote = null;
        body += c;
        i++;
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        body += c;
        i++;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      body += c;
      i++;
    }

    const pre = prelude.trim();
    if (GROUP_AT.test(pre)) {
      out += `${pre} {${scopeBlock(body, scope)}}`;
    } else if (PASSTHRU_AT.test(pre) || pre.startsWith("@")) {
      out += `${pre} {${body}}`;
    } else {
      out += `${scopeSelectorList(pre, scope)} {${body}}`;
    }
  }
  return out;
}

function scopeSelectorList(selectorList: string, scope: string): string {
  return splitTopLevel(selectorList, ",")
    .map((s) => scopeSelector(s.trim(), scope))
    .filter(Boolean)
    .join(", ");
}

function scopeSelector(sel: string, scope: string): string {
  if (!sel) return "";
  // Whole-document selectors collapse onto the scope container itself.
  if (/^(?::root|html|body)$/i.test(sel)) return scope;
  // A leading html/body/:root maps onto the scope container.
  const stripped = sel.replace(/^\s*(?::root|html|body)\b\s*/i, "");
  if (stripped !== sel) return `${scope} ${stripped}`.trim();
  // Everything else nests under the scope.
  return `${scope} ${sel}`;
}

/** Split on `sep` only at top level (not inside (), [], or strings). */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === quote && s[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    if (c === sep && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}
