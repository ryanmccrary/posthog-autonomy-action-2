/**
 * Step 2 of the NL → Insight pipeline: turn a `CreateInsightArgs` into a
 * concrete PostHog query JSON object.
 *
 * Mirrors Max's typed sub-graphs (`add_trends_generator`, `add_funnel_generator`,
 * `add_retention_generator`, `add_sql_generator`) — same one-prompt-per-type
 * shape, but in a single file because the per-type code is identical except
 * for the prompt and the expected `kind` discriminator. If a generator grows
 * type-specific post-processing (e.g. "rewrite event names that aren't in the
 * project's schema"), split it into its own file then.
 */

import type { ClaudeClient } from '../../claude.js';
import type { ExistingEvent } from '../../posthog/client.js';
import { loadPrompt } from '../../prompts.js';
import type { CreateInsightArgs, InsightType, PostHogStructuredQuery } from '../types.js';

interface GeneratorSpec {
  promptFile: string;
  /** The `kind` field that should be present on the model's output. */
  expectedKind: PostHogStructuredQuery['kind'];
}

const GENERATORS: Record<InsightType, GeneratorSpec> = {
  trends: { promptFile: 'insight-trends.md', expectedKind: 'TrendsQuery' },
  funnel: { promptFile: 'insight-funnel.md', expectedKind: 'FunnelsQuery' },
  retention: { promptFile: 'insight-retention.md', expectedKind: 'RetentionQuery' },
  sql: { promptFile: 'insight-sql.md', expectedKind: 'HogQLQuery' },
};

export async function generateQuery(args: {
  claude: ClaudeClient;
  events: ExistingEvent[];
  args: CreateInsightArgs;
}): Promise<PostHogStructuredQuery> {
  const spec = GENERATORS[args.args.insight_type];
  const system = await loadPrompt(spec.promptFile);

  const user = [
    `Insight type: ${args.args.insight_type}`,
    `Visualization title: ${args.args.viz_title}`,
    `Visualization description: ${args.args.viz_description}`,
    '',
    'Plan to execute (`query_description`):',
    args.args.query_description,
    '',
    `Available events in the project (${args.events.length}):`,
    args.events.length
      ? args.events
          .slice(0, 30)
          .map(
            (e) =>
              `- ${e.name}` +
              (e.properties.length
                ? `\n    properties: ${e.properties.map((p) => p.name).join(', ')}`
                : ''),
          )
          .join('\n')
      : '(none — generator must work without event grounding; prefer "sql" if this happens at runtime)',
  ].join('\n');

  const { value } = await args.claude.structured<PostHogStructuredQuery>({
    system,
    user,
    maxTokens: 2000,
  });

  return enforceKind(value, spec.expectedKind);
}

/**
 * Defensive: if the model emitted the wrong `kind` discriminator (or no kind
 * at all), patch it to the expected one. The PostHog API rejects payloads
 * with mismatched `kind` so getting this wrong loses the whole insight.
 */
function enforceKind(
  query: PostHogStructuredQuery,
  expected: PostHogStructuredQuery['kind'],
): PostHogStructuredQuery {
  if (!query || typeof query !== 'object') {
    throw new Error(`Generator returned non-object query (expected kind ${expected})`);
  }
  if (query.kind !== expected) {
    return { ...query, kind: expected };
  }
  return query;
}
