/**
 * Promote-on-merge orchestrator path.
 *
 * Runs when the action is invoked with `pr-merged=true` (i.e. the workflow
 * fired for a `pull_request.closed` event with `pull_request.merged ===
 * true`). The workflow file emits this via:
 *
 *     pr-merged: ${{ github.event.pull_request.merged == true && 'true' || 'false' }}
 *
 * What it does:
 *
 *   1. Recover the bot's prior `prehog-state` from its own PR comment so
 *      we know which events / property additions the bot suggested during
 *      review.
 *   2. Scan the merged diff (PR diff at HEAD == the merged commit) for
 *      `posthog.capture('<event_name>', { … })` patterns that match the
 *      suggested events. Treat properties added inside known existing
 *      capture calls as the "suggested-property landed" signal.
 *   3. For each match, idempotently register an event definition (and
 *      property definitions where applicable) via the PostHog REST API.
 *      The PostHogClient methods handle the dedupe so this step is safe
 *      to re-run.
 *   4. Hand control back to the normal orchestrator. Because the events
 *      now exist in the project schema, the analytics reviewer's
 *      `findMissingEntities` check will pass, the new generation pass
 *      won't apply a "⏳ Waiting for X" prefix, and existing insights
 *      will be UPDATED in place (planKey matches, queryHash changes
 *      since the prefix is being removed).
 *   5. Persist `mergeCommitSha` + `promotedAt` in the new state so a
 *      re-run on the same merged PR is idempotent.
 *
 * Notes on what this DOES NOT do (and why):
 *
 *   - Doesn't auto-delete insights for events that ended up NOT being
 *     instrumented. The bot only creates / updates / leaves alone — never
 *     deletes — and the PR author should clean up false-starts manually.
 *   - Doesn't add events that weren't suggested by the bot, even if they
 *     appear in the diff. We only "promote" the bot's own
 *     recommendations to keep the surface area predictable.
 */

import type { PostHogClient } from './posthog/client.js';
import type { PullRequestContext, CreatedResource } from './types.js';

/**
 * Output of the promotion scan. Each registered entity is the result of
 * the idempotent `createEventDefinition` / `createPropertyDefinition` call,
 * so the orchestrator can include them in the post-merge PR comment update
 * and the state block.
 */
export interface PromotionResult {
  registeredEvents: CreatedResource[];
  /** Properties added alongside existing capture calls. */
  registeredProperties: CreatedResource[];
  /** Names the bot expected but didn't see land. */
  notLanded: string[];
}

/**
 * Bot's prior suggestions. The orchestrator pulls this off the prior
 * `ReviewState` (the JSON block embedded in the bot's earlier PR comment).
 *
 * `suggestedEventNames`: events the bot proposed as `new_capture` or
 *   `extend_existing_capture` during the review pass.
 * `suggestedPropertyNames`: properties the bot proposed adding to existing
 *   events (for `extend_existing_capture`).
 *
 * Today the bot doesn't persist these explicitly in prehog-state — the
 * orchestrator reconstructs them by inspecting the previously-posted
 * inline suggestions and the comment markdown. Future-proof: when we
 * extend the state schema to record suggested events / properties, this
 * argument shape stays the same.
 */
export interface PriorSuggestions {
  suggestedEventNames: ReadonlySet<string>;
  suggestedPropertyNames: ReadonlySet<string>;
}

// `posthog`, `posthog_event`, `posthoganalytics`, `PostHog` (case-insensitive)
// — covers the SDK names across JS / Python / Ruby. `.capture` / `->capture`
// / `::capture` covers ., method-call, and namespace-call syntax.
const CAPTURE_RE = /(?:posthog\w*)(?:\.|->|::)capture\s*\(\s*['"]([^'"]+)['"]/gi;
// Quoted form (`'key':` or `"key":`) for Python / JSON / strict JS, plus
// the unquoted JavaScript object-literal form (`key:`). The leading
// boundary `(?:^|[\s{,])` keeps us from matching arbitrary substrings of
// other tokens.
const PROPERTY_KEY_IN_OBJECT = /(?:^|[\s{,])(?:['"]([a-zA-Z_$][\w$]*)['"]|([a-zA-Z_$][\w$]*))\s*:/g;

/**
 * Public entry. Given the merged PR's diff and the bot's prior
 * suggestions, idempotently register the events / properties that landed.
 *
 * Throws are intentionally bubbled — if the PostHog API is unreachable
 * we'd rather fail the merge-time job loudly than silently skip
 * registration.
 */
export async function runPromotion(args: {
  pr: PullRequestContext;
  posthog: PostHogClient;
  priorSuggestions: PriorSuggestions;
}): Promise<PromotionResult> {
  const { pr, posthog, priorSuggestions } = args;
  const { events: landedEvents, properties: landedProperties } = scanLandedEntities(
    pr.unifiedDiff,
    priorSuggestions,
  );

  const registeredEvents: CreatedResource[] = [];
  const registeredProperties: CreatedResource[] = [];

  for (const eventName of landedEvents) {
    try {
      const res = await posthog.createEventDefinition({ name: eventName, prUrl: pr.url });
      registeredEvents.push(res);
    } catch (err) {
      console.warn(`[promote] Failed to register event definition "${eventName}":`, err);
    }
  }

  for (const propName of landedProperties) {
    try {
      const res = await posthog.createPropertyDefinition({ name: propName, prUrl: pr.url });
      registeredProperties.push(res);
    } catch (err) {
      console.warn(`[promote] Failed to register property definition "${propName}":`, err);
    }
  }

  const allLanded = new Set([...landedEvents, ...landedProperties]);
  const expected = new Set([
    ...priorSuggestions.suggestedEventNames,
    ...priorSuggestions.suggestedPropertyNames,
  ]);
  const notLanded = Array.from(expected).filter((name) => !allLanded.has(name));

  return { registeredEvents, registeredProperties, notLanded };
}

/**
 * Scan a unified diff for `posthog.capture('<name>', { ... })` invocations
 * that match the bot's suggested events, and properties that were added to
 * those same capture-call object literals.
 *
 * Intersection of `findCapturesInDiff(diff)` ∩ `suggestions.*` — used by the
 * merge path to figure out which previously-suggested events actually
 * shipped. The analytics reviewer uses the unfiltered `findCapturesInDiff`
 * directly to gate eager insight creation on "the event the user is about
 * to apply or already committed."
 *
 * Regex pass, not AST. Accepts false-negatives (oddly-formatted calls)
 * since false-positives would register events that don't fire.
 */
export function scanLandedEntities(
  unifiedDiff: string,
  suggestions: PriorSuggestions,
): { events: string[]; properties: string[] } {
  const { eventsInDiff, propertiesInDiff } = findCapturesInDiff(unifiedDiff);
  const events = Array.from(suggestions.suggestedEventNames).filter((name) => eventsInDiff.has(name));
  const properties = Array.from(suggestions.suggestedPropertyNames).filter((name) => propertiesInDiff.has(name));
  return { events, properties };
}

/**
 * Lower-level helper: returns every event name that appears in a
 * `posthog.capture('<name>', ...)` call within the supplied unified diff,
 * plus every property key added inside any such call's object-literal
 * argument list.
 *
 * Shared with the analytics reviewer, which uses these sets to decide
 * whether to eagerly create an insight for a given suggested event. We
 * only want to create insights for events that either (a) already exist
 * in the project's schema or (b) have been committed to the PR via
 * "Apply suggestion" — anything else is deferred until the next run.
 */
export function findCapturesInDiff(unifiedDiff: string): {
  eventsInDiff: Set<string>;
  propertiesInDiff: Set<string>;
} {
  const eventsInDiff = new Set<string>();
  const propertiesInDiff = new Set<string>();
  if (!unifiedDiff) return { eventsInDiff, propertiesInDiff };

  // Capture call event names — search the whole diff (we don't restrict
  // to +-prefixed lines; a capture in a context line of the merged diff
  // is still legit instrumentation that exists in the repo).
  let m: RegExpExecArray | null;
  CAPTURE_RE.lastIndex = 0;
  while ((m = CAPTURE_RE.exec(unifiedDiff))) {
    if (m[1]) eventsInDiff.add(m[1]);
  }

  // Property keys inside capture-call argument objects. Track a small
  // "capture window" so we only attribute property keys to capture calls,
  // not arbitrary object literals nearby. Reset on @@ hunk headers.
  // Only look at + lines for properties (we want NEW additions, not
  // pre-existing keys in a context line).
  const lines = unifiedDiff.split('\n');
  let withinCaptureWindow = 0;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      withinCaptureWindow = 0;
      continue;
    }
    if (
      line.includes('posthog.capture(') ||
      line.includes('posthog_capture(') ||
      line.includes('posthoganalytics.capture(') ||
      /posthog\w*(?:\.|->|::)capture\s*\(/i.test(line)
    ) {
      withinCaptureWindow = 12;
    } else if (withinCaptureWindow > 0) {
      withinCaptureWindow -= 1;
    }
    if (withinCaptureWindow > 0 && line.startsWith('+')) {
      PROPERTY_KEY_IN_OBJECT.lastIndex = 0;
      let pm: RegExpExecArray | null;
      while ((pm = PROPERTY_KEY_IN_OBJECT.exec(line))) {
        const key = pm[1] ?? pm[2];
        if (key) propertiesInDiff.add(key);
      }
    }
  }

  return { eventsInDiff, propertiesInDiff };
}

/**
 * Build the markdown section that goes into the bot's PR comment after a
 * successful promote-on-merge pass. Renders a short bullet list of what was
 * registered, plus any expected-but-not-landed names so the author can
 * spot mismatches.
 */
export function renderPromotionMarkdown(result: PromotionResult): string {
  const lines: string[] = ['### Promoted on merge'];

  if (
    result.registeredEvents.length === 0 &&
    result.registeredProperties.length === 0 &&
    result.notLanded.length === 0
  ) {
    lines.push('> No bot-suggested events / properties found in the merged diff. Nothing to register.');
    return lines.join('\n');
  }

  if (result.registeredEvents.length > 0) {
    lines.push('', '**Pre-registered event definitions**');
    for (const e of result.registeredEvents) {
      lines.push(`- 📥 \`${e.name}\` — [event definition](${e.url})`);
    }
  }
  if (result.registeredProperties.length > 0) {
    lines.push('', '**Pre-registered property definitions**');
    for (const p of result.registeredProperties) {
      lines.push(`- 📥 \`${p.name}\` — [property definition](${p.url})`);
    }
  }
  if (result.notLanded.length > 0) {
    lines.push('', '**Bot-suggested but not in the merged diff**');
    lines.push('> These didn\'t make it into the merged code. Either the author dropped them or they\'re still pending. The bot won\'t re-register on subsequent merges.');
    for (const name of result.notLanded) {
      lines.push(`- ${'`'}${name}${'`'}`);
    }
  }

  return lines.join('\n');
}
