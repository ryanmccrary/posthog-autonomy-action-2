import { z } from 'zod';
import 'dotenv/config';

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
  return configSchema.parse({
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL,
    posthogHost: process.env.POSTHOG_HOST,
    posthogPersonalApiKey: process.env.POSTHOG_PERSONAL_API_KEY,
    posthogProjectId: process.env.POSTHOG_PROJECT_ID,
    posthogMcpUrl: process.env.POSTHOG_MCP_URL,
    posthogMcpToken: process.env.POSTHOG_MCP_TOKEN,
    githubToken: process.env.GITHUB_TOKEN,
    githubRepository: process.env.GITHUB_REPOSITORY,
    githubPrNumber: process.env.GITHUB_PR_NUMBER,
    enabledReviewers: process.env.ENABLED_REVIEWERS,
    createResources: process.env.CREATE_RESOURCES,
    insightBudgetSmall: process.env.INSIGHT_BUDGET_SMALL,
    insightBudgetLarge: process.env.INSIGHT_BUDGET_LARGE,
    enableInlineSuggestions: process.env.ENABLE_INLINE_SUGGESTIONS,
    suggestionConfidenceThreshold: process.env.SUGGESTION_CONFIDENCE_THRESHOLD,
    suggestionMax: process.env.SUGGESTION_MAX,
    slackBotToken: process.env.SLACK_BOT_TOKEN,
  });
}
