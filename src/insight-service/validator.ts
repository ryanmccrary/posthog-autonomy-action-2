/**
 * Step 3 of the NL → Insight pipeline: dry-run the generated structured
 * query against PostHog before persisting it as an insight.
 *
 * Mirrors what Max's InsightsGraph does after the typed generator runs (it
 * passes the output through a `query_executor` node that catches schema /
 * runtime errors before the insight reaches the user).
 *
 * We POST to `/api/projects/:id/query/`, which executes the query and
 * returns either the result or a structured error. We don't care about the
 * result here — we only want to know "does this query parse and run."
 *
 * The validator never throws on an invalid query: it returns
 * `{ valid: false, error }` so the caller can decide whether to skip the
 * insight or fall back to a simpler shape.
 */

import type { PostHogClient } from '../posthog/client.js';
import type { PostHogStructuredQuery } from './types.js';

export interface ValidationOutcome {
  valid: boolean;
  error?: string;
}

export async function validateQuery(args: {
  posthog: PostHogClient;
  query: PostHogStructuredQuery;
}): Promise<ValidationOutcome> {
  try {
    await args.posthog.runQuery(args.query);
    return { valid: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, error: message.slice(0, 500) };
  }
}
