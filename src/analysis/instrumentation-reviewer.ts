import type { ClaudeClient } from '../claude.js';
import { loadPrompt } from '../prompts.js';
import { stripUntrustedMarkdown } from '../sanitize.js';
import type {
  CustomerProductMix,
  FeatureSummary,
  InlineSuggestion,
  PostHogProduct,
  PullRequestContext,
  ReviewerOutput,
} from '../types.js';

interface GenericReviewerResult {
  applicable: boolean;
  suggestions: Array<Record<string, unknown>>;
  reasoning: string;
  service?: string;
  inlineSuggestions?: Array<Omit<InlineSuggestion, 'reviewer'>>;
}

interface ReviewerSpec {
  name: 'logs' | 'errors' | 'llm';
  product: PostHogProduct;
  promptFile: string;
  heading: string;
  renderSuggestion: (s: Record<string, unknown>) => string;
}

const SPECS: Record<'logs' | 'errors' | 'llm', ReviewerSpec> = {
  logs: {
    name: 'logs',
    product: 'logs',
    promptFile: 'logs.md',
    heading: 'Logs',
    renderSuggestion: (s) => {
      const level = String(s.level ?? 'info').toUpperCase();
      const props = Array.isArray(s.contextProperties) ? (s.contextProperties as string[]).join(', ') : '';
      return [
        `- **[${level}]** \`${String(s.callSite ?? '')}\` — ${String(s.message ?? '')}`,
        props ? `    - properties: ${props}` : '',
        s.rationale ? `    - _${String(s.rationale)}_` : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
  errors: {
    name: 'errors',
    product: 'error_tracking',
    promptFile: 'errors.md',
    heading: 'Error tracking',
    renderSuggestion: (s) => {
      return [
        `- \`${String(s.callSite ?? '')}\` — **${String(s.errorCategory ?? '')}**`,
        s.exampleCall ? `    \`\`\`\n    ${String(s.exampleCall)}\n    \`\`\`` : '',
        s.fingerprint ? `    - fingerprint: \`${String(s.fingerprint)}\`` : '',
        s.rationale ? `    - _${String(s.rationale)}_` : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
  llm: {
    name: 'llm',
    product: 'llm_analytics',
    promptFile: 'llm.md',
    heading: 'LLM analytics',
    renderSuggestion: (s) => {
      const fields = Array.isArray(s.fields) ? (s.fields as string[]).join(', ') : '';
      return [
        `- \`${String(s.callSite ?? '')}\` — provider \`${String(s.provider ?? '')}\``,
        fields ? `    - capture: ${fields}` : '',
        s.rationale ? `    - _${String(s.rationale)}_` : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
};

export async function runInstrumentationReviewer(args: {
  kind: 'logs' | 'errors' | 'llm';
  claude: ClaudeClient;
  pr: PullRequestContext;
  summary: FeatureSummary;
  productMix: CustomerProductMix;
}): Promise<ReviewerOutput> {
  const spec = SPECS[args.kind];
  const enabled = args.productMix.enabled[spec.product];
  const relevant = args.summary.relevantProducts.includes(spec.product);

  if (!enabled || !relevant) {
    return {
      reviewer: spec.name,
      applicable: false,
      summary: !enabled
        ? `${spec.product} not enabled on the project`
        : `${spec.product} not deemed relevant for this PR`,
      markdown: '',
      createdResources: [],
      inlineSuggestions: [],
    };
  }

  const system = await loadPrompt(spec.promptFile);
  const user = [
    'Feature summary (JSON):',
    JSON.stringify(args.summary, null, 2),
    '',
    `PR URL: ${args.pr.url}`,
    `PR title: ${args.pr.title}`,
    '',
    'Diff (truncated):',
    '```diff',
    args.pr.unifiedDiff,
    '```',
  ].join('\n');

  const { value } = await args.claude.structured<GenericReviewerResult>({
    system,
    user,
    maxTokens: 2500,
  });

  // Security (audit Finding 1): scrub model-emitted prose before it lands in
  // any rendered output. We touch every visible string field on the
  // per-reviewer suggestion shape (message, rationale, callSite, etc.) so
  // logs / errors / llm reviewers are uniformly safe regardless of which
  // kind's renderer interpolates which fields.
  value.reasoning = stripUntrustedMarkdown(value.reasoning);
  if (value.service) value.service = stripUntrustedMarkdown(value.service);
  for (const s of value.suggestions) {
    for (const key of Object.keys(s)) {
      const v = s[key];
      if (typeof v === 'string') s[key] = stripUntrustedMarkdown(v);
      else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
        s[key] = (v as string[]).map(stripUntrustedMarkdown);
      }
    }
  }
  if (value.inlineSuggestions) {
    for (const s of value.inlineSuggestions) {
      s.explanation = stripUntrustedMarkdown(s.explanation);
    }
  }

  if (!value.applicable || value.suggestions.length === 0) {
    return {
      reviewer: spec.name,
      applicable: false,
      summary: value.reasoning,
      markdown: '',
      createdResources: [],
      inlineSuggestions: [],
    };
  }

  const md: string[] = [`### ${spec.heading}`];
  if (value.reasoning) md.push(`> ${value.reasoning.trim()}`);
  if (spec.name === 'logs' && value.service) md.push(`_Service tag: \`${value.service}\`_`);
  md.push('', ...value.suggestions.map(spec.renderSuggestion));

  const inlineSuggestions: InlineSuggestion[] = (value.inlineSuggestions ?? []).map((s) => ({
    ...s,
    reviewer: spec.name,
  }));

  return {
    reviewer: spec.name,
    applicable: true,
    summary: value.reasoning,
    markdown: md.join('\n'),
    createdResources: [],
    inlineSuggestions,
  };
}
