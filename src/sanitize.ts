/**
 * Sanitizes model-emitted prose before it lands in any rendered output
 * (GitHub PR comments, GitHub review-comment bodies, PostHog insight
 * descriptions, etc.).
 *
 * Fixes security-audit Finding 1 — indirect prompt injection embedded in a
 * PR diff can otherwise steer Claude into emitting markdown image syntax,
 * inline HTML, or javascript:/data: schemes into prose fields. When the bot
 * renders those fields into a PR comment, GitHub's Camo image proxy
 * auto-fetches them on any reviewer's view, leaking the bot's analysis
 * context to attacker-controlled origins.
 *
 * Design choices:
 *
 *   - We DO strip markdown image syntax (` ![alt](url) ` and reference form),
 *     raw HTML `<img>`/`<script>`/`<iframe>`/`<embed>`/`<object>`/`<video>`/
 *     `<audio>`/`<source>`/`<svg>`/`<link>`/`<meta>`/`<style>` tags, and
 *     `javascript:`/`data:`/`vbscript:`/`file:` URL schemes used inside
 *     markdown link targets.
 *   - We DO NOT strip benign markdown (bold, italics, code spans, ordinary
 *     links, lists, blockquotes). The bot's own renderers rely on these.
 *   - We DO NOT touch code suggestion bodies (` ```suggestion ` blocks),
 *     PostHog query JSON, or other fields where text is meant to be
 *     interpreted as code/data. Callers apply this only to prose fields
 *     explicitly.
 *
 * Defense in depth: even if a marginal vector slipped past this sanitizer,
 * PreHog does not store or render its outputs anywhere that
 * could leak more than the bot's analysis context — but the audit
 * specifically flagged image auto-fetch via Camo, and that's what this
 * closes.
 */

const MARKDOWN_IMAGE_INLINE = /!\[[^\]]*\]\([^)]*\)/g;
const MARKDOWN_IMAGE_REFERENCE = /!\[[^\]]*\]\[[^\]]*\]/g;
const MARKDOWN_REFERENCE_DEFINITION = /^\s*\[[^\]]+\]:\s*\S+.*$/gm;
const DANGEROUS_HTML_TAGS =
  /<\/?(?:img|script|iframe|embed|object|video|audio|source|svg|link|meta|style|base|form|input|button)\b[^>]*>/gi;
const DANGEROUS_URL_SCHEME_IN_LINK = /\]\(\s*(?:javascript|data|vbscript|file):[^)]*\)/gi;
const BARE_DANGEROUS_URL = /\b(?:javascript|data|vbscript):[^\s)]+/gi;

/**
 * Strip patterns that can render an auto-fetched resource or run script
 * when this string is interpreted as markdown / HTML by GitHub.
 *
 * Callers must apply this to EVERY field where the value comes from the
 * model and ends up in a rendered comment body. See:
 *   - src/analysis/semantic.ts (FeatureSummary)
 *   - src/analysis/analytics-reviewer.ts (reasoning, event triggers, insight names/desc)
 *   - src/analysis/instrumentation-reviewer.ts (reasoning + per-suggestion fields)
 *   - src/analysis/flags-reviewer.ts (motivation, registration/gate strings, example patterns)
 *   - src/inline-suggestions.ts (the `explanation` field only — never the suggestion body)
 */
export function stripUntrustedMarkdown(text: unknown): string {
  if (text === null || text === undefined) return '';
  if (typeof text !== 'string') return '';
  let out = text;
  out = out.replace(MARKDOWN_IMAGE_INLINE, '');
  out = out.replace(MARKDOWN_IMAGE_REFERENCE, '');
  out = out.replace(MARKDOWN_REFERENCE_DEFINITION, '');
  out = out.replace(DANGEROUS_HTML_TAGS, '');
  out = out.replace(DANGEROUS_URL_SCHEME_IN_LINK, '](#disallowed-scheme)');
  out = out.replace(BARE_DANGEROUS_URL, '(scheme stripped)');
  // Tidy whitespace introduced by stripping.
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/**
 * Convenience: sanitize an array of strings, dropping null/undefined entries.
 */
export function stripUntrustedMarkdownAll(values: readonly unknown[]): string[] {
  return values.map(stripUntrustedMarkdown).filter((s) => s.length > 0);
}
