import Anthropic from '@anthropic-ai/sdk';

/**
 * Thin wrapper that defaults to prompt caching for the static "system" portion
 * and standardises JSON-mode-ish extraction.
 */
export class ClaudeClient {
  private readonly client: Anthropic;
  readonly model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  /**
   * Run a structured call: a long, cacheable system block plus a fresh user message.
   * Returns the parsed JSON object from the model's last text block.
   */
  async structured<T>(args: {
    system: string;
    user: string;
    maxTokens?: number;
    /** Optional extra cacheable docs (concatenated after system, before user). */
    contextDocs?: string;
  }): Promise<{ value: T; raw: string; usage: Anthropic.Messages.Usage }> {
    const systemBlocks: Anthropic.Messages.TextBlockParam[] = [
      { type: 'text', text: args.system, cache_control: { type: 'ephemeral' } },
    ];
    if (args.contextDocs) {
      systemBlocks.push({
        type: 'text',
        text: args.contextDocs,
        cache_control: { type: 'ephemeral' },
      });
    }

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: args.maxTokens ?? 4096,
      system: systemBlocks,
      messages: [{ role: 'user', content: args.user }],
    });

    const text = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    const value = parseJsonObject<T>(text);
    return { value, raw: text, usage: response.usage };
  }
}

/**
 * Extract the first balanced JSON object/array from a model reply, tolerating
 * wrapping prose or ```json fences.
 */
export function parseJsonObject<T>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/m.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();

  // Walk to find the first balanced { ... } or [ ... ] in the candidate.
  for (const open of ['{', '[']) {
    const start = candidate.indexOf(open);
    if (start < 0) continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i++) {
      const c = candidate[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === '\\') {
        escaped = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          const slice = candidate.slice(start, i + 1);
          return JSON.parse(slice) as T;
        }
      }
    }
  }

  throw new Error(`Failed to find JSON in model output. First 400 chars:\n${text.slice(0, 400)}`);
}
