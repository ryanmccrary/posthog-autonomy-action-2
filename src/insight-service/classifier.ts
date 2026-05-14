/**
 * Step 1 of the NL → Insight pipeline: classify a free-form English insight
 * description into the structured `CreateInsightArgs` shape that mirrors
 * Max's `CreateInsightToolArgs` Pydantic class.
 *
 * The classifier produces:
 *   - `insight_type`: which typed generator to dispatch to
 *   - `viz_title` + `viz_description`: stable display text for the PostHog UI
 *   - `query_description`: a refined, complete NL plan the typed generator
 *     can execute against (often longer than the user's original description
 *     because the classifier expands implicit defaults — date range,
 *     interval, breakdown, math)
 *
 * One Claude call. Structured output via the existing claude.structured()
 * helper; no MCP, no tool use.
 */

import type { ClaudeClient } from '../claude.js';
import type { ExistingEvent } from '../posthog/client.js';
import { loadPrompt } from '../prompts.js';
import { stripUntrustedMarkdown } from '../sanitize.js';
import type { CreateInsightArgs, InsightType } from './types.js';

const VALID_TYPES: ReadonlySet<InsightType> = new Set(['trends', 'funnel', 'retention', 'sql']);

export async function classifyInsight(args: {
  claude: ClaudeClient;
  events: ExistingEvent[];
  description: string;
  prefer_type?: InsightType;
}): Promise<CreateInsightArgs> {
  const system = await loadPrompt('insight-classifier.md');

  const user = [
    args.prefer_type ? `prefer_type=${args.prefer_type} (use unless description clearly contradicts)` : 'No prefer_type hint.',
    '',
    `Available events in the project (${args.events.length}):`,
    args.events.length
      ? args.events
          .slice(0, 30)
          .map(
            (e) =>
              `- ${e.name} (30d usage: ${e.queryUsage30d})` +
              (e.properties.length
                ? `\n    properties: ${e.properties.map((p) => p.name).join(', ')}`
                : ''),
          )
          .join('\n')
      : '(none — caller passed no event context)',
    '',
    'User description of the insight to create:',
    args.description,
  ].join('\n');

  const { value } = await args.claude.structured<CreateInsightArgs>({
    system,
    user,
    maxTokens: 1500,
  });

  return normalise(value, args);
}

/**
 * Defensive cleanup: enforce the type contract even if the model wandered.
 * Strips markdown injection from the visible fields (defence-in-depth on top
 * of the existing comment-renderer sanitisation), normalises insight_type to
 * the valid Literal, and falls back to `sql` if the model picked something
 * we don't have a generator for.
 */
function normalise(raw: CreateInsightArgs, fallback: { description: string; prefer_type?: InsightType }): CreateInsightArgs {
  const type: InsightType = VALID_TYPES.has(raw.insight_type)
    ? raw.insight_type
    : fallback.prefer_type && VALID_TYPES.has(fallback.prefer_type)
      ? fallback.prefer_type
      : 'sql';

  return {
    insight_type: type,
    viz_title: stripUntrustedMarkdown(raw.viz_title || fallback.description.slice(0, 60)),
    viz_description: stripUntrustedMarkdown(raw.viz_description || fallback.description),
    query_description: stripUntrustedMarkdown(raw.query_description || fallback.description),
  };
}
