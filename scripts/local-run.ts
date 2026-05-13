/**
 * Local dev runner. Runs the full pipeline against a fixture or a real GitHub
 * PR, without invoking the GitHub Action wrapper. Useful for iterating on
 * prompts.
 *
 *   npm run local                                  # uses fixture
 *   npm run local -- --pr 54115                    # fetches real PR from GH
 *   npm run local -- --pr 54115 --dry              # don't write to PostHog or GitHub
 *   npm run local -- --pr 54115 --no-mcc           # skip MCP, REST only
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ClaudeClient } from '../src/claude.js';
import { GitHubClient } from '../src/github.js';
import { PostHogClient } from '../src/posthog/client.js';
import { RESTTransport } from '../src/posthog/transports.js';
import { summarizeFeature } from '../src/analysis/semantic.js';
import { runAnalyticsReviewer } from '../src/analysis/analytics-reviewer.js';
import { runInstrumentationReviewer } from '../src/analysis/instrumentation-reviewer.js';
import { runFlagsReviewer } from '../src/analysis/flags-reviewer.js';
import { buildSlackOptInPlan } from '../src/slack.js';
import { renderFinalComment } from '../src/comment.js';
import { emptyState, parseStateFromComment, type ReviewState } from '../src/state.js';
import type {
  CreatedResource,
  CustomerProductMix,
  InsightPlan,
  PullRequestContext,
  ReviewerOutput,
} from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));

interface Args {
  prNumber?: number;
  dry: boolean;
  fixture: string;
  repository: string;
  noMcp: boolean;
  /** Path to a JSON file containing prior state (simulating an existing PR comment). */
  priorStatePath?: string;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = {
    dry: false,
    fixture: 'pr-54115-scheduled-workflows.json',
    repository: process.env.GITHUB_REPOSITORY ?? 'PostHog/posthog',
    noMcp: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--pr') out.prNumber = Number(args[++i]);
    else if (a === '--dry') out.dry = true;
    else if (a === '--fixture') out.fixture = args[++i] ?? out.fixture;
    else if (a === '--repo') out.repository = args[++i] ?? out.repository;
    else if (a === '--no-mcp') out.noMcp = true;
    else if (a === '--prior-state') out.priorStatePath = args[++i];
  }
  return out;
}

async function loadPRFromFixture(name: string): Promise<PullRequestContext> {
  const raw = await readFile(join(here, '..', 'fixtures', name), 'utf8');
  const obj = JSON.parse(raw) as PullRequestContext;
  obj.unifiedDiff = obj.changedFiles
    .map((f) => `\n--- ${f.path} (${f.status} +${f.additions} -${f.deletions}) ---\n${f.patch ?? ''}`)
    .join('\n');
  return obj;
}

async function main(): Promise<void> {
  const args = parseArgs();

  const model = process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-7';
  const claude = new ClaudeClient(requireEnv('ANTHROPIC_API_KEY'), model);

  let pr: PullRequestContext;
  let github: GitHubClient | null = null;

  if (args.prNumber) {
    github = new GitHubClient(requireEnv('GITHUB_TOKEN'), args.repository);
    pr = await github.getPullRequestContext(args.prNumber);
    console.log(`Loaded real PR ${args.repository}#${args.prNumber}`);
  } else {
    pr = await loadPRFromFixture(args.fixture);
    console.log(`Loaded fixture: ${args.fixture}`);
  }

  if (!github) {
    github = makeStubGithub();
  }

  // PostHog client: in --dry or when keys missing we substitute a stub.
  let posthog: PostHogClient;
  let productMix: CustomerProductMix;
  if (args.dry || !process.env.POSTHOG_PERSONAL_API_KEY) {
    posthog = makeStubPostHog();
    productMix = {
      enabled: {
        product_analytics: true,
        logs: true,
        error_tracking: true,
        llm_analytics: false,
        feature_flags: true,
        session_replay: false,
        surveys: false,
        experiments: false,
        data_warehouse: false,
        cdp: false,
      },
      slackIntegrationEnabled: true,
    };
    console.log('[dry-run] Using stub PostHog client');
  } else {
    const mcpUrl = !args.noMcp ? process.env.POSTHOG_MCP_URL ?? 'https://mcp.posthog.com/mcp' : undefined;
    posthog = PostHogClient.fromConfig({
      host: process.env.POSTHOG_HOST ?? 'https://us.posthog.com',
      apiKey: process.env.POSTHOG_PERSONAL_API_KEY,
      projectId: Number(requireEnv('POSTHOG_PROJECT_ID')),
      mcp: mcpUrl
        ? { url: mcpUrl, token: process.env.POSTHOG_MCP_TOKEN ?? process.env.POSTHOG_PERSONAL_API_KEY ?? '' }
        : undefined,
    });
    productMix = await posthog.detectCustomerProductMix();
  }

  // Prior state — from --prior-state file or empty.
  let priorState: ReviewState = emptyState();
  if (args.priorStatePath) {
    const raw = await readFile(args.priorStatePath, 'utf8');
    priorState = parseStateFromComment(raw) ?? priorState;
    console.log(`[local-run] Loaded ${priorState.created.length} prior resource(s) from ${args.priorStatePath}`);
  }
  const newState: ReviewState = emptyState();

  const summary = await summarizeFeature(claude, pr);
  console.log('\n--- Feature summary ---');
  console.log(JSON.stringify(summary, null, 2));

  const outputs: ReviewerOutput[] = [];
  outputs.push(
    await runAnalyticsReviewer({
      claude,
      github,
      posthog,
      pr,
      summary,
      productMix,
      insightBudgetSmall: 3,
      insightBudgetLarge: 5,
      createResources: !args.dry,
      priorState,
      newState,
    }),
  );
  for (const kind of ['logs', 'errors', 'llm'] as const) {
    outputs.push(await runInstrumentationReviewer({ kind, claude, pr, summary, productMix }));
  }
  outputs.push(
    await runFlagsReviewer({
      claude,
      posthog,
      pr,
      summary,
      productMix,
      createResources: !args.dry,
      userApprovedFlagCreation: false,
      priorState,
      newState,
    }),
  );

  const slackPlan = buildSlackOptInPlan({
    pr,
    createdResources: outputs.flatMap((o) => o.createdResources),
    customerHasSlackIntegration: productMix.slackIntegrationEnabled,
    slackBotTokenAvailable: Boolean(process.env.SLACK_BOT_TOKEN),
  });

  const comment = renderFinalComment({ pr, summary, productMix, outputs, slackPlan, state: newState });

  console.log('\n--- Final comment markdown ---\n');
  console.log(comment);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

function makeStubGithub(): GitHubClient {
  // Subclass with no-op overrides so reviewers + orchestrator can call them safely.
  return new (class extends GitHubClient {
    constructor() {
      super('unused-token', 'PostHog/posthog');
    }
    async getFileAtSha(): Promise<string | null> {
      return null;
    }
    async searchCode(): Promise<Array<{ path: string; url: string }>> {
      return [];
    }
    async getExistingReviewComment(): Promise<string | null> {
      return null;
    }
    async getLabels(): Promise<string[]> {
      return [];
    }
    async upsertReviewComment(): Promise<void> {
      console.log('[dry-run] (skipping PR comment upsert)');
    }
    async postReviewWithSuggestions(args: {
      comments: Array<unknown>;
    }): Promise<{ id: number; url: string }> {
      console.log(`[dry-run] (would post a review with ${args.comments.length} inline suggestion(s))`);
      return { id: 0, url: 'about:blank' };
    }
  })();
}

function makeStubPostHog(): PostHogClient {
  // We construct a real PostHogClient backed by a fake REST transport so the
  // class shape is correct, then override the methods reviewers actually call.
  const fakeRest = new RESTTransport({ host: 'https://us.posthog.com', apiKey: 'stub', projectId: 0 });
  const client = new PostHogClient(fakeRest);

  type Stubbable = PostHogClient & {
    findExistingEvents: PostHogClient['findExistingEvents'];
    createInsight: PostHogClient['createInsight'];
    updateInsight: PostHogClient['updateInsight'];
    createDashboard: PostHogClient['createDashboard'];
    addInsightToDashboard: PostHogClient['addInsightToDashboard'];
    createDraftFeatureFlag: PostHogClient['createDraftFeatureFlag'];
    detectCustomerProductMix: PostHogClient['detectCustomerProductMix'];
  };
  const s = client as Stubbable;

  s.findExistingEvents = async () => [
    {
      name: 'hog_flow_created',
      properties: [{ name: 'flow_id', type: 'String' }, { name: 'user_id', type: 'String' }],
      recentlySeen: true,
      queryUsage30d: 42,
    },
    {
      name: 'hog_flow_activated',
      properties: [{ name: 'flow_id', type: 'String' }],
      recentlySeen: true,
      queryUsage30d: 20,
    },
  ];

  s.createInsight = async (plan: InsightPlan): Promise<CreatedResource> => ({
    kind: 'insight',
    id: Math.floor(Math.random() * 1e6),
    name: plan.name,
    url: `https://us.posthog.com/project/0/insights/stub-${encodeURIComponent(plan.name).slice(0, 20)}`,
  });

  s.updateInsight = async ({ id, plan }): Promise<CreatedResource> => ({
    kind: 'insight',
    id,
    name: plan.name,
    url: `https://us.posthog.com/project/0/insights/${id}`,
  });

  s.createDashboard = async (name: string): Promise<CreatedResource> => ({
    kind: 'dashboard',
    id: Math.floor(Math.random() * 1e6),
    name,
    url: `https://us.posthog.com/project/0/dashboard/stub-${encodeURIComponent(name).slice(0, 20)}`,
  });

  s.addInsightToDashboard = async () => undefined;

  s.createDraftFeatureFlag = async (args): Promise<CreatedResource> => ({
    kind: 'feature_flag',
    id: Math.floor(Math.random() * 1e6),
    name: args.key,
    url: `https://us.posthog.com/project/0/feature_flags/stub-${args.key}`,
  });

  return client;
}

main().catch((err) => {
  console.error('local-run failed:', err);
  process.exit(1);
});
