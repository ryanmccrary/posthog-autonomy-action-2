import { z } from 'zod';
import * as core from '@actions/core';
import * as github from '@actions/github';
import 'dotenv/config';

/**
 * Read a GitHub Actions input. Falls back to the given environment variable
 * name so the action also works when invoked outside of Actions (e.g. locally
 * with plain env vars).
 */
function input(actionInput: string, envFallback?: string): string | undefined {
  const val = core.getInput(actionInput);
  if (val !== '') return val;
  if (envFallback) return process.env[envFallback];
  return undefined;
}

const reviewerName = z.enum(['analytics', 'logs', 'errors', 'llm', 'flags']);
export type ReviewerName = z.infer<typeof reviewerName>;

const configSchema = z.object({
  anthropicApiKey: z.string().min(1),
  model: z.string().default('claude-opus-4-7'),

  posthogHost: z.string().url().default('https://us.posthog.com'),
  posthogPersonalApiKey: z.string().min(1),
  posthogProjectId: z.coerce.number().int().positive(),

  /**
   * MCP-first: when set, every PostHog call goes through this MCP endpoint
   * (JSON-RPC `tools/call`) before falling back to REST. Defaults to the
   * PostHog remote MCP at https://mcp.posthog.com/mcp; set POSTHOG_MCP_URL=""
   * (empty string) to skip MCP entirely and go straight to REST.
   */
  posthogMcpUrl: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 'https://mcp.posthog.com/mcp' : v.trim()))
    .transform((v) => (v.length === 0 ? undefined : v))
    .pipe(z.string().url().optional()),
  posthogMcpToken: z.string().optional(),

  githubToken: z.string().min(1),
  githubRepository: z.string().regex(/^[^/]+\/[^/]+$/, 'expected owner/repo'),
  githubPrNumber: z.coerce.number().int().positive(),

  enabledReviewers: z
    .string()
    .default('analytics,logs,errors,llm,flags')
    .transform((s) => s.split(',').map((p) => p.trim()).filter(Boolean))
    .pipe(z.array(reviewerName)),

  createResources: z.coerce.boolean().default(true),
  insightBudgetSmall: z.coerce.number().int().positive().default(3),
  insightBudgetLarge: z.coerce.number().int().positive().default(5),

  /**
   * Whether to post Greptile-style line-anchored ` ```suggestion ` blocks for
   * mechanical changes. When false, those suggestions are downgraded into the
   * summary comment.
   */
  enableInlineSuggestions: z.coerce.boolean().default(true),
  /**
   * Minimum bot-self-rated confidence for a suggestion to be posted inline.
   * Lower-confidence suggestions fall back to the summary comment.
   */
  suggestionConfidenceThreshold: z.coerce.number().min(0).max(1).default(0.65),
  /** Cap on how many inline suggestions to post in one review. */
  suggestionMax: z.coerce.number().int().positive().default(12),

  slackBotToken: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  const posthogProjectId = input('posthog-project-id', 'POSTHOG_PROJECT_ID');
  console.log(`[autonomy-bot] debug: posthog-project-id input=${JSON.stringify(core.getInput('posthog-project-id'))}, env=${JSON.stringify(process.env.POSTHOG_PROJECT_ID)}, resolved=${JSON.stringify(posthogProjectId)}`);

  return configSchema.parse({
    anthropicApiKey: input('anthropic-api-key', 'ANTHROPIC_API_KEY'),
    model: input('model', 'ANTHROPIC_MODEL'),
    posthogHost: input('posthog-host', 'POSTHOG_HOST'),
    posthogPersonalApiKey: input('posthog-personal-api-key', 'POSTHOG_PERSONAL_API_KEY'),
    posthogProjectId: input('posthog-project-id', 'POSTHOG_PROJECT_ID'),
    posthogMcpUrl: input('posthog-mcp-url', 'POSTHOG_MCP_URL'),
    posthogMcpToken: input('posthog-mcp-token', 'POSTHOG_MCP_TOKEN'),
    githubToken: input('github-token', 'GITHUB_TOKEN'),
    githubRepository: process.env.GITHUB_REPOSITORY,
    githubPrNumber: github.context.payload.pull_request?.number ?? process.env.GITHUB_PR_NUMBER,
    enabledReviewers: input('enabled-reviewers', 'ENABLED_REVIEWERS'),
    createResources: input('create-resources', 'CREATE_RESOURCES'),
    insightBudgetSmall: input('insight-budget-small', 'INSIGHT_BUDGET_SMALL'),
    insightBudgetLarge: input('insight-budget-large', 'INSIGHT_BUDGET_LARGE'),
    enableInlineSuggestions: input('enable-inline-suggestions', 'ENABLE_INLINE_SUGGESTIONS'),
    suggestionConfidenceThreshold: input('suggestion-confidence-threshold', 'SUGGESTION_CONFIDENCE_THRESHOLD'),
    suggestionMax: input('suggestion-max', 'SUGGESTION_MAX'),
    slackBotToken: input('slack-bot-token', 'SLACK_BOT_TOKEN'),
  });
}
