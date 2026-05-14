/**
 * Shared types used across analyzers and the orchestrator.
 */

export type PostHogProduct =
  | 'product_analytics'
  | 'logs'
  | 'error_tracking'
  | 'llm_analytics'
  | 'feature_flags'
  | 'session_replay'
  | 'surveys'
  | 'experiments'
  | 'data_warehouse'
  | 'cdp';

export interface PullRequestContext {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  baseSha: string;
  headSha: string;
  author: string;
  url: string;
  changedFiles: ChangedFile[];
  /** Concatenated unified diff trimmed to a reasonable budget. */
  unifiedDiff: string;
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string;
}

/**
 * Output of the semantic PR-summarizer. The downstream reviewers consume this
 * structured object rather than the raw diff so prompt costs stay bounded.
 */
export interface FeatureSummary {
  /** One-line description of the feature being introduced or extended. */
  oneLine: string;
  /** 2-4 sentence narrative. */
  narrative: string;
  /** Estimated size — drives insight budgets and dashboard creation. */
  size: 'small' | 'medium' | 'large';
  /** Key user-facing capabilities (verbs the user can now do). */
  capabilities: string[];
  /** Surfaces touched (e.g. "workflows", "tracing", "subscriptions"). */
  surfaces: string[];
  /** Whether the PR extends an EXISTING feature (vs. brand-new). */
  extendsExisting: boolean;
  /** Names of existing features this one extends, if any. */
  extendsFeatures: string[];
  /** Which PostHog products are likely relevant. */
  relevantProducts: PostHogProduct[];
  /** Free-form rationale the model produced. Useful for debugging. */
  rationale: string;
}

export interface EventSuggestion {
  /** Snake_case event name following PostHog conventions. */
  name: string;
  /** When the event should fire, in plain English. */
  trigger: string;
  /** Suggested properties with type hints. */
  properties: Array<{ name: string; type: string; description: string }>;
  /** Whether this is a NEW event or an addition to an EXISTING event. */
  kind: 'new' | 'extend_existing';
  /** If `kind === extend_existing`, name of the event being extended. */
  existingEventName?: string;
  /** Files / line ranges where this event would likely be fired from. */
  suggestedCallSites: string[];
  /** Confidence 0-1. */
  confidence: number;
}

export interface LogSuggestion {
  service: string;
  level: 'debug' | 'info' | 'warning' | 'error';
  message: string;
  contextProperties: string[];
  callSite: string;
  rationale: string;
}

export interface ErrorTrackingSuggestion {
  /** File:line ranges where errors could be swallowed or unreported. */
  callSite: string;
  /** The error class / category that should be captured. */
  errorCategory: string;
  /** Suggested capture call, in the language of the file. */
  exampleCall: string;
  /** Optional fingerprint/grouping hint. */
  fingerprint?: string;
  rationale: string;
}

export interface LLMTrackingSuggestion {
  /** Provider / model integration point. */
  provider: string;
  callSite: string;
  /** What to track (prompt, completion, tokens, cost, latency, tools). */
  fields: string[];
  rationale: string;
}

export interface FeatureFlagSuggestion {
  flagKey: string;
  /** Where to register the constant on each side. */
  registrationPoints: string[];
  /** Where the flag should branch / gate. */
  gateSites: { frontend: string[]; backend: string[] };
  /** Why this PR warrants a flag (gradual rollout, capability gate, killswitch, etc). */
  motivation: string;
  /** Scope: percentage rollout vs. organization/team capability gate. */
  scope: 'percentage_rollout' | 'capability_gate' | 'killswitch';
  /** True if the user must confirm before the bot creates the flag. */
  needsPermission: boolean;
}

/**
 * What the analytics LLM emits for each insight it wants the bot to create.
 * Deliberately small: the model only describes what insight it wants in
 * English; the NL → structured-query translation happens downstream in
 * `src/insight-service/`. This split mirrors PostHog's Max AI tool, where
 * the parent agent picks `insight_type` + `viz_*` and a typed sub-graph
 * generates the actual query JSON.
 */
export interface InsightSpec {
  /**
   * Stable kebab-case slug that uniquely identifies the purpose of the
   * insight. Used to match this spec against a previously-created insight
   * across re-runs (idempotency).
   */
  planKey: string;
  /**
   * Free-form English description of the insight to create. This is the
   * input to `describeToInsight()`. Be specific about events, breakdown
   * dimension, time range, and what question the insight answers.
   */
  description: string;
  /**
   * Optional bias for the insight-service classifier. Set when the analytics
   * reviewer has high confidence about the type (e.g. an ordered-events
   * sequence is clearly a funnel). The classifier may override if the
   * description contradicts the hint.
   */
  preferType?: 'trends' | 'funnel' | 'retention' | 'sql';
  /** Optional dashboard name to attach this insight to. */
  dashboardName?: string;
}

/**
 * The fully-resolved insight ready to POST to PostHog. Built by the
 * analytics reviewer after running each `InsightSpec` through
 * `describeToInsight()`. The `query` is the structured PostHog query JSON
 * produced by the typed generator; `name` and `description` come from the
 * classifier's `viz_title` / `viz_description`.
 */
export interface InsightPlan {
  name: string;
  /** Same `planKey` as the originating `InsightSpec`. */
  planKey: string;
  description: string;
  type: 'trends' | 'funnel' | 'retention' | 'sql';
  query: Record<string, unknown>;
  dashboardName?: string;
}

export interface CreatedResource {
  kind: 'insight' | 'dashboard' | 'feature_flag';
  id: number | string;
  name: string;
  url: string;
}

export interface ReviewerOutput {
  reviewer: 'analytics' | 'logs' | 'errors' | 'llm' | 'flags';
  applicable: boolean;
  summary: string;
  /** Markdown body for the PR comment. */
  markdown: string;
  createdResources: CreatedResource[];
  /** Anything the user must approve before the bot acts. */
  pendingPermission?: { kind: string; payload: unknown };
  /**
   * Greptile-style inline review suggestions. Each one anchors to a line range
   * inside the PR diff and is posted as a GitHub `suggestion` block. The
   * orchestrator filters by `confidence` and validates that the anchor is
   * inside a changed hunk before posting.
   */
  inlineSuggestions: InlineSuggestion[];
}

/**
 * A line-anchored suggestion the bot proposes to apply via the GitHub
 * Reviews API (`pulls.createReview` with comments). Mirrors the GitHub PR
 * review-comment shape plus the bot-side bookkeeping needed to filter, dedupe
 * across re-runs, and explain what kind of change this is.
 */
export interface InlineSuggestion {
  reviewer: 'analytics' | 'logs' | 'errors' | 'llm' | 'flags';
  /** Repo-relative path of the file the suggestion applies to. */
  path: string;
  /** Inclusive start line on the RIGHT side of the diff (1-indexed). */
  startLine: number;
  /** Inclusive end line on the RIGHT side of the diff (1-indexed). */
  endLine: number;
  /**
   * The literal text that will appear inside the ` ```suggestion ` block.
   * This REPLACES lines [startLine..endLine] when the user clicks "Apply
   * suggestion". Must NOT include the fence itself — the orchestrator wraps it.
   */
  suggestion: string;
  /** 1-2 sentence prose shown above the suggestion block. */
  explanation: string;
  /** What change category this is — drives the rendering / confidence rules. */
  kind:
    | 'extend_existing_capture'
    | 'new_capture'
    | 'log_insertion'
    | 'capture_exception_wrap'
    | 'llm_wrapper'
    | 'flag_constant_register'
    | 'flag_frontend_gate'
    | 'flag_backend_gate';
  /** 0..1 — bot self-rated. Compared against `suggestionConfidenceThreshold`. */
  confidence: number;
}

export interface CustomerProductMix {
  /** Whether the org/project ingests data for each product surface. */
  enabled: Record<PostHogProduct, boolean>;
  /** Approximate event volume — used to scale how aggressive suggestions are. */
  monthlyEvents?: number;
  /** Whether the customer has Slack integration enabled. */
  slackIntegrationEnabled: boolean;
}
