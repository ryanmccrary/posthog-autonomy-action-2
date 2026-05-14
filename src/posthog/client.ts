import type {
  CreatedResource,
  CustomerProductMix,
  InsightPlan,
  PostHogProduct,
} from '../types.js';
import { MCPTransport, MCPUnavailableError, RESTTransport } from './transports.js';

export interface ExistingEvent {
  name: string;
  properties: Array<{ name: string; type?: string | null }>;
  recentlySeen: boolean;
  queryUsage30d: number;
}

/**
 * MCP-first, REST-compatible PostHog client.
 *
 * Each method tries the corresponding PostHog MCP tool first. On
 * `MCPUnavailableError` (missing tool, transport error, non-2xx from MCP) we
 * transparently fall back to the REST transport. If only REST is configured,
 * MCP attempts are skipped entirely.
 */
export class PostHogClient {
  constructor(private readonly rest: RESTTransport, private readonly mcp?: MCPTransport) {}

  static fromConfig(args: {
    host: string;
    apiKey: string;
    projectId: number;
    mcp?: { url: string; token: string };
  }): PostHogClient {
    const rest = new RESTTransport({ host: args.host, apiKey: args.apiKey, projectId: args.projectId });
    const mcp = args.mcp ? new MCPTransport({ url: args.mcp.url, token: args.mcp.token }) : undefined;
    return new PostHogClient(rest, mcp);
  }

  get host(): string {
    return this.rest.host;
  }
  get projectId(): number {
    return this.rest.projectId;
  }

  /** MCP-first: organization-get + integrations-list. REST fallback probes endpoints. */
  async detectCustomerProductMix(): Promise<CustomerProductMix> {
    const enabled: Record<PostHogProduct, boolean> = {
      product_analytics: false,
      logs: false,
      error_tracking: false,
      llm_analytics: false,
      feature_flags: false,
      session_replay: false,
      surveys: false,
      experiments: false,
      data_warehouse: false,
      cdp: false,
    };

    // Product analytics
    const events = await this.safe(
      () => this.viaMcp<{ results: unknown[] }>('event-definition-list', { limit: 1 }),
      () => this.rest.fetchJson<{ results: unknown[] }>(`/api/projects/${this.projectId}/event_definitions/?limit=1`),
      { results: [] },
    );
    enabled.product_analytics = events.results.length > 0;

    // Feature flags
    const flags = await this.safe(
      () => this.viaMcp<{ results: unknown[] }>('feature-flag-get-all', { limit: 1 }),
      () => this.rest.fetchJson<{ results: unknown[] }>(`/api/projects/${this.projectId}/feature_flags/?limit=1`),
      null,
    );
    enabled.feature_flags = flags !== null;

    // Error tracking
    const issues = await this.safe(
      () => this.viaMcp<{ results: unknown[] }>('query-error-tracking-issues-list', { limit: 1 }),
      () => this.rest.fetchJson<{ results: unknown[] }>(`/api/environments/${this.projectId}/error_tracking/issues/?limit=1`),
      null,
    );
    enabled.error_tracking = issues !== null;

    // LLM analytics — presence of $ai_generation event def
    const llm = await this.safe(
      () => this.viaMcp<{ results: Array<{ name: string }> }>('event-definition-list', { search: '$ai_generation', limit: 1 }),
      () => this.rest.fetchJson<{ results: Array<{ name: string }> }>(
        `/api/projects/${this.projectId}/event_definitions/?search=%24ai_generation&limit=1`,
      ),
      { results: [] },
    );
    enabled.llm_analytics = llm.results?.some((e) => e.name === '$ai_generation') ?? false;

    // Logs — best-effort (probe the attributes endpoint which is a simple GET)
    const logs = await this.safe(
      () => this.viaMcp<{ results: unknown[] }>('logs-count', { limit: 1 }),
      () => this.rest.fetchJson<Record<string, unknown>>(`/api/environments/${this.projectId}/logs/attributes/`),
      null,
    );
    enabled.logs = logs !== null;

    // Session replay
    const replays = await this.safe(
      () => null as never, // No PostHog MCP tool for listing recordings (read-only API).
      () => this.rest.fetchJson<{ results: unknown[] }>(`/api/projects/${this.projectId}/session_recordings/?limit=1`),
      null,
    );
    enabled.session_replay = replays !== null;

    // Surveys
    const surveys = await this.safe(
      () => this.viaMcp<{ results: unknown[] }>('surveys-get-all', {}),
      () => this.rest.fetchJson<{ results: unknown[] }>(`/api/projects/${this.projectId}/surveys/?limit=1`),
      null,
    );
    enabled.surveys = surveys !== null;

    // Experiments
    const experiments = await this.safe(
      () => this.viaMcp<{ results: unknown[] }>('experiment-get-all', {}),
      () => this.rest.fetchJson<{ results: unknown[] }>(`/api/projects/${this.projectId}/experiments/?limit=1`),
      null,
    );
    enabled.experiments = experiments !== null;

    // Slack integration
    const integrations = await this.safe(
      () => this.viaMcp<{ results: Array<{ kind: string }> }>('integrations-list', {}),
      () => this.rest.fetchJson<{ results: Array<{ kind: string }> }>(`/api/projects/${this.projectId}/integrations/`),
      { results: [] },
    );
    const slackIntegrationEnabled = (integrations.results ?? []).some((i) => i.kind === 'slack');

    return { enabled, slackIntegrationEnabled };
  }

  /**
   * Search for events whose name matches keywords; for each, list its known
   * properties. Used by the analytics reviewer to decide which existing event
   * deserves a new property vs. needing a brand-new event.
   */
  async findExistingEvents(keywords: string[], limit = 25): Promise<ExistingEvent[]> {
    interface EventDef {
      id: string;
      name: string;
      query_usage_30_day?: number | null;
      last_seen_at?: string | null;
    }
    interface PropDef {
      id: string;
      name: string;
      property_type?: string | null;
    }

    const allDefs: EventDef[] = [];
    for (const kw of keywords.slice(0, 6)) {
      const r = await this.safe(
        () => this.viaMcp<{ results: EventDef[] }>('event-definition-list', { search: kw, limit }),
        () => this.rest.fetchJson<{ results: EventDef[] }>(
          `/api/projects/${this.projectId}/event_definitions/?search=${encodeURIComponent(kw)}&limit=${limit}`,
        ),
        { results: [] },
      );
      allDefs.push(...(r.results ?? []));
    }
    const byName = new Map<string, EventDef>();
    for (const e of allDefs) byName.set(e.name, e);

    const out: ExistingEvent[] = [];
    for (const def of byName.values()) {
      const propRes = await this.safe(
        () => this.viaMcp<{ results: PropDef[] }>('property-definition-list', {
          event_names: [def.name],
          limit: 80,
        }),
        () => this.rest.fetchJson<{ results: PropDef[] }>(
          `/api/projects/${this.projectId}/property_definitions/?event_names=%5B%22${encodeURIComponent(def.name)}%22%5D&limit=80`,
        ),
        { results: [] },
      );
      out.push({
        name: def.name,
        properties: (propRes.results ?? []).map((p) => ({ name: p.name, type: p.property_type })),
        recentlySeen: Boolean(def.last_seen_at),
        queryUsage30d: def.query_usage_30_day ?? 0,
      });
    }
    out.sort((a, b) => b.queryUsage30d - a.queryUsage30d);
    return out;
  }

  /** MCP: insight-create. */
  async createInsight(plan: InsightPlan, prUrl: string): Promise<CreatedResource> {
    const body = {
      name: plan.name,
      description: `${plan.description}\n\nAuto-created by PostHog PR Autonomy Bot for ${prUrl}`,
      query: wrapInsightQueryForStorage(plan.query),
      saved: true,
      tags: ['auto-created', 'pr-autonomy-bot'],
    };
    const res = await this.safe(
      () => this.viaMcp<{ id: number; short_id: string; name: string }>('insight-create', body),
      () => this.rest.fetchJson<{ id: number; short_id: string; name: string }>(
        `/api/projects/${this.projectId}/insights/`,
        { method: 'POST', body },
      ),
      null,
    );
    if (!res) throw new Error(`Failed to create insight "${plan.name}" via MCP or REST`);
    return {
      kind: 'insight',
      id: res.id,
      name: res.name,
      url: `${this.host}/project/${this.projectId}/insights/${res.short_id}`,
    };
  }

  /** MCP: insight-update. Used by idempotent re-runs when the query has changed. */
  async updateInsight(args: { id: number | string; plan: InsightPlan; prUrl: string }): Promise<CreatedResource> {
    const body = {
      name: args.plan.name,
      description: `${args.plan.description}\n\nUpdated by PostHog PR Autonomy Bot for ${args.prUrl}`,
      query: wrapInsightQueryForStorage(args.plan.query),
    };
    const res = await this.safe(
      () => this.viaMcp<{ id: number; short_id: string; name: string }>('insight-update', {
        insightId: args.id,
        ...body,
      }),
      () => this.rest.fetchJson<{ id: number; short_id: string; name: string }>(
        `/api/projects/${this.projectId}/insights/${args.id}/`,
        { method: 'PATCH', body },
      ),
      null,
    );
    if (!res) throw new Error(`Failed to update insight ${args.id} via MCP or REST`);
    return {
      kind: 'insight',
      id: res.id,
      name: res.name,
      url: `${this.host}/project/${this.projectId}/insights/${res.short_id}`,
    };
  }

  /** MCP: dashboard-create. */
  async createDashboard(name: string, description: string, prUrl: string): Promise<CreatedResource> {
    const body = {
      name,
      description: `${description}\n\nAuto-created by PostHog PR Autonomy Bot for ${prUrl}`,
      tags: ['auto-created', 'pr-autonomy-bot'],
    };
    const res = await this.safe(
      () => this.viaMcp<{ id: number; name: string }>('dashboard-create', body),
      () => this.rest.fetchJson<{ id: number; name: string }>(
        `/api/projects/${this.projectId}/dashboards/`,
        { method: 'POST', body },
      ),
      null,
    );
    if (!res) throw new Error(`Failed to create dashboard "${name}" via MCP or REST`);
    return {
      kind: 'dashboard',
      id: res.id,
      name: res.name,
      url: `${this.host}/project/${this.projectId}/dashboard/${res.id}`,
    };
  }

  /** MCP: dashboard-update — adds a tile linking an insight to a dashboard. */
  async addInsightToDashboard(insightId: number | string, dashboardId: number | string): Promise<void> {
    await this.safe(
      () => this.viaMcp<void>('dashboard-update', {
        dashboardId,
        insights_to_add: [insightId],
      }),
      () => this.rest.fetchJson(`/api/projects/${this.projectId}/insights/${insightId}/`, {
        method: 'PATCH',
        body: { dashboards: [dashboardId] },
      }),
      null,
    );
  }

  /**
   * Dry-run a structured query against `/api/projects/:id/query/`. Used by
   * the insight-service validator to catch malformed queries BEFORE we POST
   * them as insights — invalid queries persisted as insights are noisy in
   * the PostHog UI and require manual cleanup.
   *
   * Throws on non-2xx; the validator catches and converts into a structured
   * `{ valid: false, error }` result. We don't need the query result itself,
   * just the schema/runtime check.
   *
   * MCP equivalent: there's no first-party MCP tool that accepts arbitrary
   * insight-shaped queries (the `query-trends`, `query-funnel`, etc. MCP
   * tools take a more constrained shape) — REST is the right path here.
   */
  async runQuery(query: Record<string, unknown>): Promise<unknown> {
    const body = { query };
    return this.rest.fetchJson<unknown>(`/api/projects/${this.projectId}/query/`, {
      method: 'POST',
      body,
    });
  }

  /**
   * Pre-register an event definition with `created_at: null` and
   * `last_seen_at: null` — the same shape the PostHog UI uses when a human
   * clicks "New event" on `/data-management/events/new`. Lets the bot
   * register the events it suggested BEFORE they've actually been ingested,
   * so insights that reference them stop being "phantom" in the UI.
   *
   * Idempotent semantics: PostHog rejects duplicate names with a 4xx; we
   * swallow that and look the existing def up by name so callers can
   * re-run the merge path safely.
   *
   * MCP: there's an `event-definition-update` tool but no `event-definition-create`,
   * so this is REST-only.
   */
  async createEventDefinition(args: { name: string; prUrl: string }): Promise<CreatedResource> {
    const body: Record<string, unknown> = {
      name: args.name,
      // The PostHog UI sets these to null when registering pre-ingestion, so
      // the new def doesn't claim to have a last-seen-at timestamp.
      created_at: null,
      last_seen_at: null,
      tags: ['auto-registered', 'pr-autonomy-bot'],
    };

    const existing = await this.findEventDefinitionByName(args.name);
    if (existing) {
      return {
        kind: 'event_definition',
        id: existing.id,
        name: existing.name,
        url: `${this.host}/project/${this.projectId}/data-management/events/${existing.id}`,
      };
    }

    try {
      const res = await this.rest.fetchJson<{ id: string; name: string }>(
        `/api/projects/${this.projectId}/event_definitions/`,
        { method: 'POST', body },
      );
      return {
        kind: 'event_definition',
        id: res.id,
        name: res.name,
        url: `${this.host}/project/${this.projectId}/data-management/events/${res.id}`,
      };
    } catch (err) {
      // Race: another call registered the same name between our check and POST.
      // Re-fetch and return that one.
      const after = await this.findEventDefinitionByName(args.name);
      if (after) {
        return {
          kind: 'event_definition',
          id: after.id,
          name: after.name,
          url: `${this.host}/project/${this.projectId}/data-management/events/${after.id}`,
        };
      }
      throw err;
    }
  }

  /**
   * Pre-register a property definition scoped to one or more events. Used
   * during promote-on-merge for properties the bot suggested adding alongside
   * existing capture calls (e.g. `trigger_type` on `hog_flow_created`).
   *
   * MCP: no first-party create tool — REST-only.
   */
  async createPropertyDefinition(args: {
    name: string;
    propertyType?: 'String' | 'Numeric' | 'Boolean' | 'DateTime';
    eventNames?: string[];
    prUrl: string;
  }): Promise<CreatedResource> {
    const body: Record<string, unknown> = {
      name: args.name,
      property_type: args.propertyType ?? 'String',
    };
    if (args.eventNames?.length) {
      body.event_names = args.eventNames;
    }

    const existing = await this.findPropertyDefinitionByName(args.name);
    if (existing) {
      return {
        kind: 'property_definition',
        id: existing.id,
        name: existing.name,
        url: `${this.host}/project/${this.projectId}/data-management/properties/${existing.id}`,
      };
    }

    try {
      const res = await this.rest.fetchJson<{ id: string; name: string }>(
        `/api/projects/${this.projectId}/property_definitions/`,
        { method: 'POST', body },
      );
      return {
        kind: 'property_definition',
        id: res.id,
        name: res.name,
        url: `${this.host}/project/${this.projectId}/data-management/properties/${res.id}`,
      };
    } catch (err) {
      const after = await this.findPropertyDefinitionByName(args.name);
      if (after) {
        return {
          kind: 'property_definition',
          id: after.id,
          name: after.name,
          url: `${this.host}/project/${this.projectId}/data-management/properties/${after.id}`,
        };
      }
      throw err;
    }
  }

  /** MCP: create-feature-flag. Always creates DRAFT (inactive, 0% rollout). */
  async createDraftFeatureFlag(args: { key: string; name: string; description: string; prUrl: string }): Promise<CreatedResource> {
    const body = {
      key: args.key,
      name: args.name,
      filters: { groups: [{ properties: [], rollout_percentage: 0 }] },
      active: false,
      ensure_experience_continuity: false,
      tags: ['auto-created', 'pr-autonomy-bot'],
    };
    const res = await this.safe(
      () => this.viaMcp<{ id: number; key: string }>('create-feature-flag', body),
      () => this.rest.fetchJson<{ id: number; key: string }>(
        `/api/projects/${this.projectId}/feature_flags/`,
        { method: 'POST', body },
      ),
      null,
    );
    if (!res) throw new Error(`Failed to create flag "${args.key}" via MCP or REST`);
    return {
      kind: 'feature_flag',
      id: res.id,
      name: res.key,
      url: `${this.host}/project/${this.projectId}/feature_flags/${res.id}`,
    };
  }

  /**
   * Try the MCP tool first. If it's not advertised, throws, or returns an
   * error, fall back to the REST call. If neither succeeds, return the
   * supplied default.
   */
  private async safe<T>(
    mcpCall: () => Promise<T> | T,
    restCall: () => Promise<T>,
    defaultValue: T,
  ): Promise<T> {
    if (this.mcp) {
      try {
        return await mcpCall();
      } catch (err) {
        if (!(err instanceof MCPUnavailableError)) {
          // Unexpected error inside the MCP path — log and fall through.
          console.warn('[posthog] MCP path threw, falling back to REST:', (err as Error).message);
        }
      }
    }
    try {
      return await restCall();
    } catch (err) {
      console.warn('[posthog] REST fallback also failed:', (err as Error).message);
      return defaultValue;
    }
  }

  private async viaMcp<T>(toolName: string, args: Record<string, unknown>): Promise<T> {
    if (!this.mcp) throw new MCPUnavailableError('No MCP transport configured');
    return this.mcp.callTool<T>(toolName, args);
  }

  /**
   * Look up an event definition by exact name. Used as the idempotency check
   * before `POST /event_definitions/` so re-runs of the merge path don't
   * 4xx on already-registered events.
   *
   * PostHog's search is `contains`, so we filter to an exact match to avoid
   * a partial substring (e.g. `hog_flow_created` vs `hog_flow_created_v2`).
   */
  private async findEventDefinitionByName(name: string): Promise<{ id: string; name: string } | null> {
    interface EventDef { id: string; name: string }
    const r = await this.safe(
      () => this.viaMcp<{ results: EventDef[] }>('event-definition-list', {
        search: name,
        limit: 10,
      }),
      () => this.rest.fetchJson<{ results: EventDef[] }>(
        `/api/projects/${this.projectId}/event_definitions/?search=${encodeURIComponent(name)}&limit=10`,
      ),
      { results: [] },
    );
    return (r.results ?? []).find((e) => e.name === name) ?? null;
  }

  /** Same shape as findEventDefinitionByName, for property definitions. */
  private async findPropertyDefinitionByName(name: string): Promise<{ id: string; name: string } | null> {
    interface PropDef { id: string; name: string }
    const r = await this.safe(
      () => this.viaMcp<{ results: PropDef[] }>('property-definition-list', {
        search: name,
        limit: 10,
      }),
      () => this.rest.fetchJson<{ results: PropDef[] }>(
        `/api/projects/${this.projectId}/property_definitions/?search=${encodeURIComponent(name)}&limit=10`,
      ),
      { results: [] },
    );
    return (r.results ?? []).find((p) => p.name === name) ?? null;
  }
}

/**
 * Wrap a raw insight query in the saved-insight storage shape PostHog's
 * frontend renderer expects.
 *
 * Background: PostHog has TWO ingestion paths for insight queries.
 *
 *  - The MCP `insight-create` tool (`MCPInsightSerializer.validate_query`
 *    in posthog/api/insight.py:1029-1067) auto-wraps raw `TrendsQuery` /
 *    `FunnelsQuery` / `RetentionQuery` / `PathsQuery` /
 *    `StickinessQuery` / `LifecycleQuery` into `InsightVizNode { source }`
 *    and raw `HogQLQuery` into `DataVisualizationNode { source }`.
 *  - The plain REST endpoint (`POST /api/projects/:id/insights/` →
 *    `InsightSerializer.QueryFieldSerializer`) does NOT auto-wrap. It just
 *    validates the value is a JSON object and stores it as-is.
 *
 * Our PostHogClient tries MCP first, falls back to REST. When the REST
 * fallback fires (or when MCP isn't configured at all), the raw query gets
 * stored without a wrapper. The PostHog UI then can't render it — the
 * insight loads with empty chart area and the type tabs default to whatever
 * is currently selected (e.g. "Trends BETA"). The query data is technically
 * persisted; it's just unreachable through the visualisation pipeline.
 *
 * Wrapping unconditionally on our side is safe because the MCP serializer's
 * validate_query loop checks for "already wrapped" first and passes those
 * through unchanged (insight.py:1054-1058).
 */
export function wrapInsightQueryForStorage(query: Record<string, unknown>): Record<string, unknown> {
  if (!query || typeof query !== 'object') return query;
  const kind = typeof query.kind === 'string' ? query.kind : undefined;

  // Already-wrapped — pass through.
  if (kind === 'InsightVizNode' || kind === 'DataVisualizationNode') {
    return query;
  }

  // HogQL → DataVisualizationNode (this is what the REST endpoint expects
  // for SQL-backed insights; see InsightSerializer + DataVisualizationNode
  // in posthog/schema.py).
  if (kind === 'HogQLQuery') {
    return { kind: 'DataVisualizationNode', source: query };
  }

  // Product-analytics queries → InsightVizNode wrapper.
  const productAnalyticsKinds = new Set([
    'TrendsQuery',
    'FunnelsQuery',
    'RetentionQuery',
    'PathsQuery',
    'StickinessQuery',
    'LifecycleQuery',
  ]);
  if (kind && productAnalyticsKinds.has(kind)) {
    return { kind: 'InsightVizNode', source: query };
  }

  // Unknown kind — pass through and let the API decide. We don't want to
  // silently rewrap something we don't recognise (e.g. a future Assistant*
  // shape), since wrapping the wrong thing also breaks rendering.
  return query;
}
