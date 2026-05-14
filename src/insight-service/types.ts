/**
 * Type definitions for the NL → PostHog Insight pipeline.
 *
 * The internal contract intentionally mirrors PostHog's Max AI tool at
 * `ee/hogai/tools/create_insight.py::CreateInsightToolArgs` so the in-bot
 * implementation can be swapped for an external Max-as-a-service call later
 * without changing any callers:
 *
 *     {
 *       query_description: str   # NL plan
 *       insight_type: Literal["trends", "funnel", "retention", "sql"]
 *       viz_title: str           # 2–7 words
 *       viz_description: str     # 1 sentence
 *     }
 *
 * NB: Max's current `CreateInsightToolArgs.insight_type` Literal does NOT
 * include `"sql"` — SQL is generable via `add_sql_generator()` on the graph
 * but not exposed as a tool argument today. We include it because (a) the
 * project spec asks for it as the fourth supported type and (b) it's the
 * natural fallback for anything trends/funnel/retention can't model.
 */

import type { ExistingEvent } from '../posthog/client.js';

/**
 * Insight kinds the service can produce. Aligned with Max's typed sub-graphs
 * (trends / funnel / retention / sql).
 *
 * Deliberately narrower than PostHog's full insight taxonomy
 * ("paths", "stickiness", "lifecycle"): keeping the surface small means the
 * classifier has to make fewer choices and we can ship a working generator
 * per type in one PR. Add more types only when the demand is clear.
 */
export type InsightType = 'trends' | 'funnel' | 'retention' | 'sql';

/**
 * The internal contract between the classifier and the per-type generator.
 * Field names are byte-for-byte identical to Max's Pydantic class so a future
 * external Max client (`posthogMaxClient.createInsight(...)`) is a drop-in
 * swap for everything below the public describeToInsight() boundary.
 */
export interface CreateInsightArgs {
  /** Natural-language plan for the query. Detailed enough for the typed generator to do its job. */
  query_description: string;
  insight_type: InsightType;
  /** Short, concise name (2–7 words). Sentence casing per PostHog naming convention. */
  viz_title: string;
  /** One-sentence summary shown under the title in the PostHog UI. */
  viz_description: string;
}

/**
 * Public input to the service. Callers (the analytics reviewer today) pass:
 *  - `events`: the candidate set of events from the customer's PostHog
 *    project that the insight may reference, with their existing properties.
 *    The classifier and generators use this to ground their output.
 *  - `description`: a short, free-form English description of the insight
 *    the bot wants to create (e.g., "Workflows activated by trigger type,
 *    weekly"). Pre-processed by the analytics reviewer if convenient, but
 *    the classifier will refine it into a tighter `query_description`.
 *  - Optional `prefer_type` lets the caller bias the classifier when it
 *    already has a strong opinion (e.g., the analytics reviewer wants this
 *    one to be a funnel because the insight follows a sequence of events).
 */
export interface DescribeToInsightArgs {
  events: ExistingEvent[];
  description: string;
  prefer_type?: InsightType;
}

/**
 * Public return shape. Carries enough context that the caller can:
 *  - POST the structured `query` to PostHog's insight-create endpoint
 *  - Show the user exactly what type/title/description will land in their
 *    PostHog project (no surprise "we created this thing")
 *  - Include the original NL plan in the bot's PR comment for traceability
 */
export interface DescribeToInsightResult {
  query: PostHogStructuredQuery;
  insight_type: InsightType;
  viz_title: string;
  viz_description: string;
  /** The (possibly refined) NL plan the generator actually consumed. */
  query_description: string;
  /** Whether `validateQuery` ran successfully against /api/projects/:id/query/. */
  validated: boolean;
  /** If validation failed, the API's error message. The caller can decide whether to skip persisting. */
  validation_error?: string;
}

/**
 * The shape PostHog's `/api/projects/:id/insights/` accepts in its `query`
 * field. We don't try to redeclare the entire HogQL/Insight schema here —
 * the per-type generator returns a record that includes a `kind` discriminator
 * (`TrendsQuery`, `FunnelsQuery`, `RetentionQuery`, `HogQLQuery`) and the
 * type-specific properties.
 *
 * If/when we move to an external Max-as-a-service call, replace this with an
 * import from a shared schema package.
 */
export type PostHogStructuredQuery = Record<string, unknown> & {
  kind: 'TrendsQuery' | 'FunnelsQuery' | 'RetentionQuery' | 'HogQLQuery';
};
