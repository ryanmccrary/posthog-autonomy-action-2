/**
 * Public entry point for the NL → PostHog Insight pipeline.
 *
 * Today this lives inside the bot. Tomorrow we'll likely point at an
 * external Max-as-a-service endpoint instead — at which point only this
 * file's implementation changes; every caller's contract stays the same.
 *
 * The pipeline:
 *
 *   1. **Classify** — one Claude call. Free-form English description +
 *      events list → `CreateInsightArgs` (insight_type / viz_title /
 *      viz_description / refined query_description). Mirrors Max's parent
 *      agent picking which typed sub-graph to dispatch to.
 *   2. **Generate** — one Claude call against a typed prompt
 *      (`insight-{trends,funnel,retention,sql}.md`) → structured PostHog
 *      query JSON. Mirrors Max's typed sub-graph generator nodes
 *      (`add_trends_generator` / `add_funnel_generator` / etc.).
 *   3. **Validate** — POST to `/api/projects/:id/query/`. If the dry-run
 *      fails, return the result with `validated: false` so the caller can
 *      decide whether to skip persisting the insight. Mirrors Max's
 *      `query_executor` node catching schema errors before the artifact
 *      reaches the user.
 *
 * Failure handling: each step is best-effort. The classifier and generator
 * are required (they throw on Claude API errors); the validator is
 * advisory (returns `validated: false` rather than throwing). This way a
 * brief PostHog-side 500 doesn't sink the whole reviewer run.
 */

import type { ClaudeClient } from '../claude.js';
import type { PostHogClient } from '../posthog/client.js';
import { classifyInsight } from './classifier.js';
import { generateQuery } from './generators/index.js';
import type { DescribeToInsightArgs, DescribeToInsightResult } from './types.js';
import { validateQuery } from './validator.js';

export async function describeToInsight(args: {
  claude: ClaudeClient;
  posthog: PostHogClient;
  /** Whether to actually run the dry-run validator step. Default true. Pass false in --dry mode. */
  validate?: boolean;
} & DescribeToInsightArgs): Promise<DescribeToInsightResult> {
  const { claude, posthog, events, description, prefer_type, validate = true } = args;

  // Step 1 — classify NL → CreateInsightArgs
  const plan = await classifyInsight({ claude, events, description, prefer_type });

  // Step 2 — generate the structured query JSON for the chosen type
  const query = await generateQuery({ claude, events, args: plan });

  // Step 3 — validate (optional). On failure we still return the query so
  // the caller can either log + skip or persist anyway with a warning.
  let validated = false;
  let validation_error: string | undefined;
  if (validate) {
    const outcome = await validateQuery({ posthog, query });
    validated = outcome.valid;
    validation_error = outcome.error;
  }

  return {
    query,
    insight_type: plan.insight_type,
    viz_title: plan.viz_title,
    viz_description: plan.viz_description,
    query_description: plan.query_description,
    validated,
    validation_error,
  };
}

// Re-export the types so call sites don't have to depth-link into the module.
export type {
  CreateInsightArgs,
  DescribeToInsightArgs,
  DescribeToInsightResult,
  InsightType,
  PostHogStructuredQuery,
} from './types.js';
