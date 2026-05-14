/**
 * MCP-first transport layer for the PostHog client.
 *
 * Two transports:
 *   - `MCPTransport` — JSON-RPC against an MCP server (default: the PostHog
 *     remote MCP at https://mcp.posthog.com/mcp). Tool names match the
 *     PostHog MCP surface (`insight-create`, `dashboard-update`, etc.).
 *   - `RESTTransport` — direct PostHog REST API. Always available as a
 *     fallback whenever the project's personal API key is supplied.
 *
 * The `PostHogClient` wraps both: every operation tries MCP first, and on a
 * tools-list miss / transport error falls back to REST. Reviewers don't care
 * which path served the call — they just see a unified async API.
 */

/** Errors that should trigger the REST fallback rather than bubbling up. */
export class MCPUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'MCPUnavailableError';
  }
}

export interface MCPTransportConfig {
  url: string;
  token: string;
  /** Optional override for the JSON-RPC client name string. */
  clientName?: string;
}

export class MCPTransport {
  private nextRequestId = 1;
  private initialized = false;
  private toolsCache: Set<string> | null = null;

  constructor(private readonly cfg: MCPTransportConfig) {}

  /** Returns the set of tool names the MCP server advertises. Cached after first call. */
  async listTools(): Promise<Set<string>> {
    if (this.toolsCache) return this.toolsCache;
    await this.ensureInitialized();
    const result = await this.rpc<{ tools: Array<{ name: string }> }>('tools/list', {});
    this.toolsCache = new Set(result.tools.map((t) => t.name));
    return this.toolsCache;
  }

  /** Returns true if the MCP server advertises a tool with the given name. */
  async hasTool(name: string): Promise<boolean> {
    const tools = await this.listTools();
    return tools.has(name);
  }

  async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.ensureInitialized();
    if (!(await this.hasTool(name))) {
      throw new MCPUnavailableError(`MCP server does not advertise tool "${name}"`);
    }
    const result = await this.rpc<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>(
      'tools/call',
      { name, arguments: args },
    );
    if (result.isError) {
      const text = result.content?.find((c) => c.type === 'text')?.text ?? 'tool reported error';
      throw new MCPUnavailableError(`MCP tool ${name} errored: ${text.slice(0, 200)}`);
    }
    // Most PostHog MCP tools return a single text block with JSON inside.
    const block = result.content?.find((c) => c.type === 'text');
    if (!block?.text) {
      // Some tools return no payload (e.g. simple updates); cast to T.
      return undefined as unknown as T;
    }
    try {
      return JSON.parse(block.text) as T;
    } catch {
      // Tool returned text but not JSON — treat as opaque success.
      return block.text as unknown as T;
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: this.cfg.clientName ?? 'prehog', version: '0.1.0' },
    });
    // The MCP spec requires sending an `initialized` notification next. For
    // simple stateless RPC against the PostHog remote MCP it's tolerated to
    // skip this, but we send it for compliance.
    try {
      await this.notify('notifications/initialized', {});
    } catch {
      // best-effort
    }
    this.initialized = true;
  }

  private async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.nextRequestId++;
    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${this.cfg.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (!res.ok) {
      throw new MCPUnavailableError(`MCP HTTP ${res.status} on ${method}: ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (json.error) {
      throw new MCPUnavailableError(`MCP error ${json.error.code} on ${method}: ${json.error.message}`);
    }
    return json.result as T;
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await fetch(this.cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${this.cfg.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
    });
  }
}

export interface RESTTransportConfig {
  host: string;
  apiKey: string;
  projectId: number;
}

/**
 * Thin REST transport. Reviewers don't call this directly — they go through
 * `PostHogClient`, which itself calls into MCP first and REST second.
 */
export class RESTTransport {
  constructor(readonly cfg: RESTTransportConfig) {}

  get projectId(): number {
    return this.cfg.projectId;
  }
  get host(): string {
    return this.cfg.host;
  }

  async fetchJson<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
    const url = `${this.cfg.host.replace(/\/$/, '')}${path}`;
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`PostHog ${opts.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }
}
