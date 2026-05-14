/**
 * Re-run state is persisted inside the bot's own PR comment so we don't need
 * an external state store. Layout:
 *
 *   ... markdown ...
 *   <!-- autonomy-state:{...JSON...} -->
 *   <!-- posthog-pr-autonomy-bot -->
 *
 * The orchestrator reads the existing comment before running, parses the JSON
 * block, hands it to reviewers, and re-embeds the updated state on save.
 */
import { createHash } from 'node:crypto';
import type { CreatedResource } from './types.js';

export const STATE_OPEN = '<!-- autonomy-state:';
export const STATE_CLOSE = '-->';

export interface PriorResource extends CreatedResource {
  planKey: string;
  /** sha1 of the canonical query JSON. Only set for insights. */
  queryHash?: string;
}

export interface ReviewState {
  version: 1;
  created: PriorResource[];
  /**
   * Fingerprints of inline review suggestions that have already been posted
   * on this PR. Used by validateSuggestions() to avoid re-posting the same
   * line-anchored comment on synchronize events.
   */
  postedSuggestions?: string[];
  /**
   * Event names the analytics reviewer suggested adding (either as new
   * captures or extensions to existing capture calls). The promote-on-merge
   * path reads this from priorState and matches against the merged diff to
   * decide which event definitions to pre-register.
   */
  suggestedEvents?: string[];
  /**
   * Property names the analytics reviewer suggested adding to existing
   * capture calls. Mirrors suggestedEvents but for property definitions.
   */
  suggestedProperties?: string[];
  /**
   * Promote-on-merge bookkeeping. Set by the orchestrator's merge path
   * when pull_request.merged === true:
   *   - mergeCommitSha: the merge commit on the base branch
   *   - promotedAt: ISO timestamp of when the promotion ran
   * Both unset on normal review runs.
   */
  mergeCommitSha?: string;
  promotedAt?: string;
}

export function emptyState(): ReviewState {
  return { version: 1, created: [], postedSuggestions: [] };
}

export function parseStateFromComment(body: string | null | undefined): ReviewState {
  if (!body) return emptyState();
  const start = body.indexOf(STATE_OPEN);
  if (start < 0) return emptyState();
  const after = body.slice(start + STATE_OPEN.length);
  const end = after.indexOf(STATE_CLOSE);
  if (end < 0) return emptyState();
  const json = after.slice(0, end).trim();
  try {
    const parsed = JSON.parse(json) as Partial<ReviewState>;
    if (parsed.version !== 1 || !Array.isArray(parsed.created)) return emptyState();
    return {
      version: 1,
      created: parsed.created.filter(isPriorResource),
      postedSuggestions: Array.isArray(parsed.postedSuggestions)
        ? parsed.postedSuggestions.filter((s): s is string => typeof s === 'string')
        : [],
      suggestedEvents: Array.isArray(parsed.suggestedEvents)
        ? parsed.suggestedEvents.filter((s): s is string => typeof s === 'string')
        : [],
      suggestedProperties: Array.isArray(parsed.suggestedProperties)
        ? parsed.suggestedProperties.filter((s): s is string => typeof s === 'string')
        : [],
      mergeCommitSha: typeof parsed.mergeCommitSha === 'string' ? parsed.mergeCommitSha : undefined,
      promotedAt: typeof parsed.promotedAt === 'string' ? parsed.promotedAt : undefined,
    };
  } catch {
    return emptyState();
  }
}

function isPriorResource(v: unknown): v is PriorResource {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.kind === 'string' &&
    (typeof r.id === 'number' || typeof r.id === 'string') &&
    typeof r.url === 'string' &&
    typeof r.name === 'string' &&
    typeof r.planKey === 'string'
  );
}

export function serializeStateBlock(state: ReviewState): string {
  // Keep the JSON dense (no whitespace) so it's a single HTML-comment line.
  return `${STATE_OPEN}${JSON.stringify(state)}${STATE_CLOSE}`;
}

/** Stable hash of the insight query JSON, so we can decide create vs. update. */
export function hashQuery(query: unknown): string {
  const canonical = canonicalize(query);
  return createHash('sha1').update(canonical).digest('hex').slice(0, 16);
}

function canonicalize(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

/**
 * Build a stable, file-system-safe key from a plan name + surface so re-runs
 * of the bot can match insight plans across LLM calls. We slug the name and
 * prefix with the first surface for extra collision resistance.
 */
export function makePlanKey(args: { surface: string | undefined; name: string }): string {
  const surface = (args.surface ?? 'general').toLowerCase();
  const slug = args.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${surface}/${slug}`;
}
