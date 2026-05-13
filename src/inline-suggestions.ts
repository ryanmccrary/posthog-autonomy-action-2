/**
 * Validation + posting for inline review suggestions (Greptile-style).
 *
 * GitHub's review-comment API requires that every comment's line anchor be
 * inside a changed hunk of the PR diff. If we post a suggestion against an
 * anchor outside the diff, the comment shows up at the top of the file
 * instead of inline — which is loud and unhelpful. So we parse each changed
 * file's patch, build a set of valid right-side line ranges, and drop or
 * fall-back-to-summary any suggestion whose anchor is invalid.
 *
 * We also dedupe against prior suggestions persisted in the bot's autonomy
 * state so we don't post the same line-anchored comment again on every
 * synchronize event.
 */
import parseDiff from 'parse-diff';
import type { ChangedFile, InlineSuggestion, PullRequestContext } from './types.js';

export interface ValidatedSuggestion extends InlineSuggestion {
  /** Whether the suggestion passed all gates (in-hunk anchor + confidence). */
  valid: boolean;
  /** Reason for being rejected, if any. */
  rejection?: string;
}

export interface ValidationContext {
  pr: PullRequestContext;
  confidenceThreshold: number;
  /**
   * Set of suggestion fingerprints already posted on a previous run.
   * Computed by the orchestrator from prior state.
   */
  alreadyPostedFingerprints: Set<string>;
}

/**
 * Build a fingerprint that's stable across re-runs as long as the suggestion's
 * "what" and "where" are unchanged. Used to skip re-posting on synchronize.
 */
export function suggestionFingerprint(s: InlineSuggestion): string {
  // We include kind + path + line range + a small prefix of the suggestion
  // body so that materially-changed suggestions register as new.
  const head = s.suggestion.slice(0, 200).replace(/\s+/g, ' ').trim();
  return `${s.kind}|${s.path}|${s.startLine}-${s.endLine}|${head}`;
}

/**
 * Build a map from path → set of valid right-side line numbers (lines that
 * appear as either context or addition inside any hunk of that file's patch).
 */
export function buildPatchAnchorIndex(files: ChangedFile[]): Map<string, Set<number>> {
  const index = new Map<string, Set<number>>();
  for (const f of files) {
    if (!f.patch) continue;
    // parseDiff expects a full unified diff with `--- a/... +++ b/...` headers.
    // GitHub gives us just the @@ hunks, so synthesize a minimal wrapper.
    const synthetic = `--- a/${f.path}\n+++ b/${f.path}\n${f.patch}`;
    const parsed = parseDiff(synthetic);
    const file = parsed[0];
    if (!file) continue;

    const lines = new Set<number>();
    for (const chunk of file.chunks) {
      for (const change of chunk.changes) {
        // parse-diff change shape: { type: 'add'|'del'|'normal', ln, ln1, ln2 }
        // For 'add' and 'normal' the new-file line number is `ln` or `ln2`.
        const c = change as unknown as { type: string; ln?: number; ln2?: number };
        if (c.type === 'add' && typeof c.ln === 'number') lines.add(c.ln);
        else if (c.type === 'normal' && typeof c.ln2 === 'number') lines.add(c.ln2);
      }
    }
    index.set(f.path, lines);
  }
  return index;
}

export function validateSuggestions(
  raw: InlineSuggestion[],
  ctx: ValidationContext,
): ValidatedSuggestion[] {
  const anchorIndex = buildPatchAnchorIndex(ctx.pr.changedFiles);
  return raw.map((s) => annotate(s, anchorIndex, ctx));
}

function annotate(
  s: InlineSuggestion,
  anchorIndex: Map<string, Set<number>>,
  ctx: ValidationContext,
): ValidatedSuggestion {
  if (s.confidence < ctx.confidenceThreshold) {
    return { ...s, valid: false, rejection: `confidence ${s.confidence.toFixed(2)} < threshold ${ctx.confidenceThreshold}` };
  }
  if (s.startLine > s.endLine) {
    return { ...s, valid: false, rejection: 'startLine > endLine' };
  }
  const validLines = anchorIndex.get(s.path);
  if (!validLines) {
    return { ...s, valid: false, rejection: `path "${s.path}" not in PR diff` };
  }
  // Both endpoints must be inside at least one hunk of the file's diff.
  if (!validLines.has(s.startLine) || !validLines.has(s.endLine)) {
    return {
      ...s,
      valid: false,
      rejection: `lines ${s.startLine}-${s.endLine} not inside a changed hunk of ${s.path}`,
    };
  }
  if (ctx.alreadyPostedFingerprints.has(suggestionFingerprint(s))) {
    return { ...s, valid: false, rejection: 'already posted on a prior run' };
  }
  return { ...s, valid: true };
}

/**
 * Render the GitHub review-comment body for one suggestion. We wrap the raw
 * `suggestion` text in a ```suggestion fence and prepend a short explainer +
 * a footer marking it as a bot-generated suggestion (so reviewers can spot
 * them in the file-changed view).
 */
export function renderSuggestionCommentBody(s: ValidatedSuggestion): string {
  const reviewerLabel: Record<InlineSuggestion['reviewer'], string> = {
    analytics: 'PostHog · product analytics',
    logs: 'PostHog · logs',
    errors: 'PostHog · error tracking',
    llm: 'PostHog · LLM analytics',
    flags: 'PostHog · feature flags',
  };
  return [
    `**${reviewerLabel[s.reviewer]} — ${humanKind(s.kind)}**`,
    '',
    s.explanation,
    '',
    '```suggestion',
    s.suggestion,
    '```',
    '',
    `<sub>Inline suggestion from PostHog PR Autonomy Bot · confidence ${(s.confidence * 100).toFixed(0)}%.</sub>`,
  ].join('\n');
}

function humanKind(k: InlineSuggestion['kind']): string {
  switch (k) {
    case 'extend_existing_capture':
      return 'add property to existing event';
    case 'new_capture':
      return 'new event';
    case 'log_insertion':
      return 'add log line';
    case 'capture_exception_wrap':
      return 'capture exception';
    case 'llm_wrapper':
      return 'wrap LLM call';
    case 'flag_constant_register':
      return 'register flag constant';
    case 'flag_frontend_gate':
      return 'frontend flag gate';
    case 'flag_backend_gate':
      return 'backend flag gate';
  }
}
