import type { ClaudeClient } from '../claude.js';
import type { GitHubClient } from '../github.js';
import { describeToInsight } from '../insight-service/index.js';
import {
  buildWaitingPrefix,
  findMissingEntities,
} from '../insight-service/referenced-entities.js';
import type { PostHogClient, ExistingEvent } from '../posthog/client.js';
import { loadPrompt } from '../prompts.js';
import { stripUntrustedMarkdown } from '../sanitize.js';
import {
  hashQuery,
  makePlanKey,
  type PriorResource,
  type ReviewState,
} from '../state.js';
import type {
  CreatedResource,
  CustomerProductMix,
  EventSuggestion,
  FeatureSummary,
  InlineSuggestion,
  InsightPlan,
  InsightSpec,
  PullRequestContext,
  ReviewerOutput,
} from '../types.js';

interface AnalyticsLLMOutput {
  events: EventSuggestion[];
  /**
   * The model only emits NL specs now; the actual TrendsQuery / FunnelsQuery
   * / RetentionQuery / HogQLQuery JSON is produced by the insight-service
   * (classifier + typed generator) downstream. See `src/insight-service/`.
   */
  insights: InsightSpec[];
  dashboardPlanKey?: string;
  reasoning: string;
  schemaViolations: Array<{ location: string; issue: string; fix: string }>;
  inlineSuggestions?: Array<Omit<InlineSuggestion, 'reviewer'>>;
}

/**
 * Action recorded for each insight on this run. The reviewer surfaces a
 * different verb in the comment based on this.
 */
type ResourceAction = 'created' | 'updated' | 'unchanged';

interface ResolvedInsight {
  plan: InsightPlan;
  resource: CreatedResource;
  /** New hash of the plan's query. */
  newHash: string;
  /** Action that was taken on this run. */
  action: ResourceAction;
  /** True if the dry-run validator confirmed PostHog accepts the query. */
  validated: boolean;
  /** If validation failed, the API's error string (truncated). */
  validationError?: string;
}

export async function runAnalyticsReviewer(args: {
  claude: ClaudeClient;
  github: GitHubClient;
  posthog: PostHogClient;
  pr: PullRequestContext;
  summary: FeatureSummary;
  productMix: CustomerProductMix;
  insightBudgetSmall: number;
  insightBudgetLarge: number;
  createResources: boolean;
  /** Prior state from the bot's previous comment on this PR. */
  priorState: ReviewState;
  /** Mutated by this reviewer to record what was created / updated this run. */
  newState: ReviewState;
}): Promise<ReviewerOutput> {
  const { claude, github, posthog, pr, summary, priorState, newState } = args;

  if (!summary.relevantProducts.includes('product_analytics')) {
    return {
      reviewer: 'analytics',
      applicable: false,
      summary: 'product_analytics not deemed relevant by semantic summary',
      markdown: '',
      createdResources: [],
      inlineSuggestions: [],
    };
  }

  // 1. Find existing events on surfaces this PR touches.
  const keywords = dedupe([
    ...summary.surfaces,
    ...summary.extendsFeatures,
    ...summary.capabilities.flatMap(splitToWords),
  ]).slice(0, 8);
  const existingEvents = await posthog.findExistingEvents(keywords);
  // Pre-flatten event + property name sets so each insight's "missing
  // entities" scan stays O(refs) rather than O(refs × events).
  const existingEventNames = new Set(existingEvents.map((e) => e.name));
  const existingPropertyNames = new Set(
    existingEvents.flatMap((e) => e.properties.map((p) => p.name)),
  );

  // 2. Scan nearby tracking calls.
  const nearbyCalls = await collectNearbyTrackingCalls(github, summary, pr);

  // 3. Pick the insight budget.
  const insightBudget = summary.size === 'small' ? args.insightBudgetSmall : args.insightBudgetLarge;

  // 4. Ask Claude for events + insight plans.
  const system = await loadPrompt('analytics.md');
  const user = buildAnalyticsUserMessage({
    pr,
    summary,
    existingEvents,
    nearbyCalls,
    insightBudget,
    priorPlanKeys: priorState.created
      .filter((r) => r.kind === 'insight')
      .map((r) => r.planKey),
  });
  const { value: plan } = await claude.structured<AnalyticsLLMOutput>({
    system,
    user,
    maxTokens: 4000,
  });

  // Security (audit Finding 1): scrub markdown image/HTML/script injection
  // from every model-emitted prose field before we render or POST it. The
  // insight-service output (structured PostHog query JSON) and the inline
  // `suggestion` body are intentionally NOT touched here — those are
  // structured data / code, handled elsewhere.
  plan.reasoning = stripUntrustedMarkdown(plan.reasoning);
  for (const e of plan.events) {
    e.trigger = stripUntrustedMarkdown(e.trigger);
    for (const p of e.properties) {
      p.description = stripUntrustedMarkdown(p.description);
    }
  }
  for (const i of plan.insights) {
    // InsightSpec only carries the NL `description`; the classifier produces
    // viz_title / viz_description, which the insight-service runs through
    // its own sanitiser.
    i.description = stripUntrustedMarkdown(i.description);
  }
  for (const v of plan.schemaViolations ?? []) {
    v.issue = stripUntrustedMarkdown(v.issue);
    v.fix = stripUntrustedMarkdown(v.fix);
  }
  if (plan.inlineSuggestions) {
    for (const s of plan.inlineSuggestions) {
      s.explanation = stripUntrustedMarkdown(s.explanation);
    }
  }

  // 5. Resolve insights: classifier + typed generator + validator (the
  //    NL → structured-query pipeline), THEN create vs update vs leave-alone.
  const resolved: ResolvedInsight[] = [];
  const obsoletePrior: PriorResource[] = [];

  if (args.createResources && plan.insights.length > 0) {
    const prevByKey = new Map<string, PriorResource>();
    for (const p of priorState.created) {
      if (p.kind === 'insight') prevByKey.set(p.planKey, p);
    }

    // Decide on dashboard first so we have an id to attach insights to.
    const wantsDashboard = summary.size !== 'small' && plan.insights.length > 1;
    let dashboardResource: CreatedResource | undefined;

    if (wantsDashboard) {
      const dashKey = plan.dashboardPlanKey
        ?? makePlanKey({ surface: summary.surfaces[0], name: `${summary.surfaces[0] ?? 'feature'} dashboard` });
      const prevDash = priorState.created.find((p) => p.kind === 'dashboard' && p.planKey === dashKey);
      const dashName = plan.insights[0]?.dashboardName ?? defaultDashboardName(summary);
      try {
        if (prevDash) {
          dashboardResource = {
            kind: 'dashboard',
            id: prevDash.id,
            name: prevDash.name,
            url: prevDash.url,
          };
          newState.created.push({ ...prevDash, planKey: dashKey });
        } else {
          dashboardResource = await posthog.createDashboard(
            dashName,
            `Auto-generated for ${summary.oneLine}`,
            pr.url,
          );
          newState.created.push({ ...dashboardResource, planKey: dashKey });
        }
      } catch (err) {
        console.warn('[analytics] Failed to create/reuse dashboard:', err);
      }
    }

    for (const spec of plan.insights.slice(0, insightBudget)) {
      const key = spec.planKey || makePlanKey({ surface: summary.surfaces[0], name: spec.description });
      spec.planKey = key;

      // NL → structured-query pipeline. One classifier call + one typed
      // generator call + an optional validator dry-run. The reviewer is no
      // longer responsible for picking insight types or hand-crafting query
      // JSON — that lives in src/insight-service/.
      let insightPlan: InsightPlan;
      let validated = false;
      let validationError: string | undefined;
      try {
        const result = await describeToInsight({
          claude,
          posthog,
          events: existingEvents,
          description: spec.description,
          prefer_type: spec.preferType,
          validate: true,
        });
        validated = result.validated;
        validationError = result.validation_error;
        if (!validated) {
          console.warn(
            `[analytics] Insight "${spec.description.slice(0, 60)}" failed validator: ${validationError}`,
          );
        }
        // Detect references to events/properties the project hasn't seen
        // and prefix the visible description with a "⏳ Waiting for X"
        // marker. This is forward-looking insights' biggest UX problem:
        // the bot creates a chart for an event the developer hasn't
        // instrumented yet, so the chart renders empty and there's no
        // signal to the viewer about why. The marker makes that explicit.
        const missing = findMissingEntities({
          query: result.query,
          existingEventNames,
          existingPropertyNames,
        });
        const waitingPrefix = buildWaitingPrefix(missing);

        insightPlan = {
          name: result.viz_title,
          planKey: key,
          description: waitingPrefix
            ? `${waitingPrefix}\n\n${result.viz_description}`
            : result.viz_description,
          type: result.insight_type,
          query: result.query,
          dashboardName: spec.dashboardName,
        };
      } catch (err) {
        console.warn(`[analytics] describeToInsight failed for spec "${spec.description.slice(0, 60)}":`, err);
        continue;
      }

      // If the dry-run failed and we're not creating an insight with a
      // known-bad query, skip persistence — surface in the comment so the
      // reviewer can iterate on the description.
      if (!validated) {
        resolved.push({
          plan: insightPlan,
          resource: {
            kind: 'insight',
            id: 0,
            name: insightPlan.name,
            url: '(not created — validator failed)',
          },
          newHash: hashQuery(insightPlan.query),
          action: 'created',
          validated: false,
          validationError,
        });
        continue;
      }

      const newHash = hashQuery(insightPlan.query);
      const prev = prevByKey.get(key);

      try {
        if (prev && prev.queryHash === newHash) {
          resolved.push({
            plan: insightPlan,
            resource: { kind: 'insight', id: prev.id, name: prev.name, url: prev.url },
            newHash,
            action: 'unchanged',
            validated: true,
          });
          newState.created.push({ ...prev, planKey: key, queryHash: newHash });
          prevByKey.delete(key);
        } else if (prev) {
          const updated = await posthog.updateInsight({ id: prev.id, plan: insightPlan, prUrl: pr.url });
          resolved.push({ plan: insightPlan, resource: updated, newHash, action: 'updated', validated: true });
          newState.created.push({ ...updated, planKey: key, queryHash: newHash });
          prevByKey.delete(key);
        } else {
          const created = await posthog.createInsight(insightPlan, pr.url);
          resolved.push({ plan: insightPlan, resource: created, newHash, action: 'created', validated: true });
          newState.created.push({ ...created, planKey: key, queryHash: newHash });
          if (dashboardResource) {
            await posthog.addInsightToDashboard(created.id, dashboardResource.id);
          }
        }
      } catch (err) {
        console.warn(`[analytics] Failed to resolve insight "${insightPlan.name}":`, err);
      }
    }

    for (const leftover of prevByKey.values()) obsoletePrior.push(leftover);
  }

  const markdown = renderAnalyticsMarkdown({
    plan,
    resolved,
    obsoletePrior,
    pr,
  });

  const inlineSuggestions: InlineSuggestion[] = (plan.inlineSuggestions ?? []).map((s) => ({
    ...s,
    reviewer: 'analytics' as const,
  }));

  return {
    reviewer: 'analytics',
    applicable: true,
    summary: plan.reasoning,
    markdown,
    createdResources: resolved.map((r) => r.resource),
    inlineSuggestions,
  };
}

function buildAnalyticsUserMessage(args: {
  pr: PullRequestContext;
  summary: FeatureSummary;
  existingEvents: ExistingEvent[];
  nearbyCalls: Array<{ snippet: string; path: string }>;
  insightBudget: number;
  priorPlanKeys: string[];
}): string {
  const { pr, summary, existingEvents, nearbyCalls, insightBudget, priorPlanKeys } = args;
  return [
    `INSIGHT_BUDGET=${insightBudget}`,
    '',
    priorPlanKeys.length
      ? `Existing insight planKeys from a previous run of this bot (KEEP these stable so insights are matched on re-run rather than duplicated):\n${priorPlanKeys.map((k) => `  - ${k}`).join('\n')}`
      : 'No prior insight planKeys.',
    '',
    'Feature summary (JSON):',
    JSON.stringify(summary, null, 2),
    '',
    `Existing events from this project that touch related surfaces (${existingEvents.length}):`,
    existingEvents.length
      ? existingEvents
          .slice(0, 25)
          .map(
            (e) =>
              `- ${e.name} (30d usage: ${e.queryUsage30d})\n    properties: ${e.properties.map((p) => p.name).join(', ') || '(none indexed)'}`,
          )
          .join('\n')
      : '(none found — feature appears to add a brand-new surface)',
    '',
    `Nearby tracking call sites in the repo (${nearbyCalls.length}):`,
    nearbyCalls.length
      ? nearbyCalls.slice(0, 15).map((c) => `- ${c.path}: \`${c.snippet}\``).join('\n')
      : '(none found)',
    '',
    `PR URL: ${pr.url}`,
    `PR title: ${pr.title}`,
    '',
    'Diff (truncated):',
    '```diff',
    pr.unifiedDiff,
    '```',
  ].join('\n');
}

async function collectNearbyTrackingCalls(
  github: GitHubClient,
  summary: FeatureSummary,
  pr: PullRequestContext,
): Promise<Array<{ snippet: string; path: string }>> {
  const out: Array<{ snippet: string; path: string }> = [];

  for (const file of pr.changedFiles.slice(0, 25)) {
    if (file.status === 'removed') continue;
    const contents = await github.getFileAtSha(file.path, pr.headSha);
    if (!contents) continue;
    for (const m of findCaptureCalls(contents)) {
      out.push({ snippet: m, path: file.path });
    }
  }

  for (const surface of summary.surfaces.slice(0, 2)) {
    const items = await github.searchCode(`"posthog.capture" ${surface}`, 5);
    for (const it of items) {
      out.push({ snippet: `(search hit) ${it.url}`, path: it.path });
    }
  }

  return out.slice(0, 30);
}

const CAPTURE_RE = /(posthog(?:_event)?(?:\.|->|::)capture[^\n]{0,180})/g;
function findCaptureCalls(source: string): string[] {
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = CAPTURE_RE.exec(source))) {
    const snip = m[1]?.replace(/\s+/g, ' ').trim();
    if (snip) matches.push(snip);
  }
  return matches.slice(0, 8);
}

function renderAnalyticsMarkdown(args: {
  plan: AnalyticsLLMOutput;
  resolved: ResolvedInsight[];
  obsoletePrior: PriorResource[];
  pr: PullRequestContext;
}): string {
  const { plan, resolved, obsoletePrior } = args;
  const lines: string[] = [];

  lines.push('### Product analytics');
  if (plan.reasoning) lines.push(`> ${plan.reasoning.trim()}`);

  if (plan.events.length) {
    lines.push('', '**Suggested events**');
    for (const e of plan.events) {
      const label = e.kind === 'extend_existing' ? `extend \`${e.existingEventName}\`` : 'new event';
      lines.push(`- **${e.name}** _(${label}, confidence ${(e.confidence * 100).toFixed(0)}%)_ — ${e.trigger}`);
      for (const p of e.properties) {
        lines.push(`    - \`${p.name}\` _(${p.type})_ — ${p.description}`);
      }
      if (e.suggestedCallSites.length) {
        lines.push(`    - Fire from: ${e.suggestedCallSites.map((s) => `\`${s}\``).join(', ')}`);
      }
    }
  }

  if (plan.schemaViolations.length) {
    lines.push('', '**Schema violations in this PR**');
    for (const v of plan.schemaViolations) {
      lines.push(`- \`${v.location}\` — ${v.issue}. Fix: ${v.fix}`);
    }
  }

  const dashboards = resolved
    .map((r) => r.resource)
    .filter((r) => r.kind === 'dashboard');
  const insightLines = resolved.map((r) => renderInsightLine(r));

  if (dashboards.length || insightLines.length) {
    lines.push('', '**In PostHog**');
    for (const d of dashboards) lines.push(`- 📊 Dashboard: [${d.name}](${d.url})`);
    for (const l of insightLines) lines.push(l);
  } else if (plan.insights.length) {
    lines.push('', '**Suggested insights** _(not auto-created)_');
    for (const spec of plan.insights) {
      // InsightSpec only carries the NL description + planKey; the
      // viz_title comes from the classifier and isn't available when
      // create-resources is off.
      lines.push(`- \`${spec.planKey}\` — ${spec.description}`);
    }
  }

  if (obsoletePrior.length) {
    lines.push('', '**Previously created, no longer in plan**');
    lines.push(
      '> These were auto-created by an earlier run but the current PR no longer suggests them. Left untouched — delete in PostHog if you no longer want them.',
    );
    for (const o of obsoletePrior) {
      lines.push(`- ${iconFor(o.kind)} [${o.name}](${o.url})`);
    }
  }

  return lines.join('\n');
}

function renderInsightLine(r: ResolvedInsight): string {
  if (!r.validated && r.resource.id === 0) {
    return `- ⚠️ skipped — _${r.plan.name}_ (\`${r.plan.type}\`): ${r.validationError ?? 'validator failed'}`;
  }
  const verb = r.action === 'unchanged' ? '↔ unchanged' : r.action === 'updated' ? '✏️ updated' : '✨ created';
  return `- 📈 ${verb} \`${r.plan.type}\` — [${r.resource.name}](${r.resource.url})`;
}

function iconFor(kind: string): string {
  switch (kind) {
    case 'insight':
      return '📈';
    case 'dashboard':
      return '📊';
    case 'feature_flag':
      return '🚩';
    default:
      return '•';
  }
}

function defaultDashboardName(summary: FeatureSummary): string {
  const base = summary.surfaces[0] ?? summary.extendsFeatures[0] ?? 'New feature';
  return `${capitalize(base)} — auto-generated`;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function splitToWords(s: string): string[] {
  return s.split(/[\s_\-/]+/).map((w) => w.toLowerCase()).filter((w) => w.length > 2);
}
