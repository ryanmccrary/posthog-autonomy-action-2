import type { ClaudeClient } from '../claude.js';
import type { PostHogClient } from '../posthog/client.js';
import { loadPrompt } from '../prompts.js';
import { stripUntrustedMarkdown, stripUntrustedMarkdownAll } from '../sanitize.js';
import { makePlanKey, type ReviewState } from '../state.js';
import type {
  CustomerProductMix,
  FeatureSummary,
  InlineSuggestion,
  PullRequestContext,
  ReviewerOutput,
} from '../types.js';

interface FlagLLMOutput {
  applicable: boolean;
  reasoning: string;
  suggestion?: {
    flagKey: string;
    motivation: string;
    scope: 'percentage_rollout' | 'capability_gate' | 'killswitch';
    registrationPoints: string[];
    gateSites: { frontend: string[]; backend: string[] };
    examplePatterns: string[];
  };
  inlineSuggestions?: Array<Omit<InlineSuggestion, 'reviewer'>>;
}

/**
 * Re-runs are idempotent: we read the existing PR comment (or sidecar marker)
 * to decide whether the user has already granted permission to create the flag.
 * For the MVP we expose the permission ask in the PR comment markdown and let
 * the user opt in by reacting to the comment or by re-running the action with
 * a label like `prehog:create-flag`. The orchestrator inspects PR labels
 * and sets `userApprovedFlagCreation` before invoking this reviewer.
 */
export async function runFlagsReviewer(args: {
  claude: ClaudeClient;
  posthog: PostHogClient;
  pr: PullRequestContext;
  summary: FeatureSummary;
  productMix: CustomerProductMix;
  createResources: boolean;
  userApprovedFlagCreation: boolean;
  priorState: ReviewState;
  newState: ReviewState;
}): Promise<ReviewerOutput> {
  const { claude, posthog, pr, summary, priorState, newState } = args;

  if (!summary.relevantProducts.includes('feature_flags')) {
    return {
      reviewer: 'flags',
      applicable: false,
      summary: 'feature_flags not deemed relevant by semantic summary',
      markdown: '',
      createdResources: [],
      inlineSuggestions: [],
    };
  }

  const system = await loadPrompt('flags.md');
  const user = [
    'Feature summary (JSON):',
    JSON.stringify(summary, null, 2),
    '',
    `PR URL: ${pr.url}`,
    `PR title: ${pr.title}`,
    '',
    'Diff (truncated):',
    '```diff',
    pr.unifiedDiff,
    '```',
  ].join('\n');

  const { value } = await claude.structured<FlagLLMOutput>({ system, user, maxTokens: 2200 });

  // Security (audit Finding 1): scrub model-emitted prose. Note: flagKey is
  // also model-controlled; PostHog server-side validates flag keys (kebab
  // case, length-limited) so we don't need to add another layer here, but
  // sanitizing it as defence-in-depth costs nothing.
  value.reasoning = stripUntrustedMarkdown(value.reasoning);
  if (value.suggestion) {
    const s = value.suggestion;
    s.flagKey = stripUntrustedMarkdown(s.flagKey);
    s.motivation = stripUntrustedMarkdown(s.motivation);
    s.registrationPoints = stripUntrustedMarkdownAll(s.registrationPoints ?? []);
    s.gateSites = {
      frontend: stripUntrustedMarkdownAll(s.gateSites?.frontend ?? []),
      backend: stripUntrustedMarkdownAll(s.gateSites?.backend ?? []),
    };
    s.examplePatterns = stripUntrustedMarkdownAll(s.examplePatterns ?? []);
  }
  if (value.inlineSuggestions) {
    for (const sug of value.inlineSuggestions) {
      sug.explanation = stripUntrustedMarkdown(sug.explanation);
    }
  }

  if (!value.applicable || !value.suggestion) {
    return {
      reviewer: 'flags',
      applicable: false,
      summary: value.reasoning || 'No feature flag recommended for this PR.',
      markdown: '',
      createdResources: [],
      inlineSuggestions: [],
    };
  }

  const s = value.suggestion;
  const created: ReviewerOutput['createdResources'] = [];
  let pendingPermission: ReviewerOutput['pendingPermission'];

  const planKey = makePlanKey({ surface: summary.surfaces[0], name: s.flagKey });
  const priorFlag = priorState.created.find(
    (p) => p.kind === 'feature_flag' && p.planKey === planKey,
  );

  if (priorFlag) {
    // Already created on a previous run — just re-link, never auto-update flags.
    created.push({ kind: 'feature_flag', id: priorFlag.id, name: priorFlag.name, url: priorFlag.url });
    newState.created.push({ ...priorFlag, planKey });
  } else if (args.createResources && args.userApprovedFlagCreation) {
    try {
      const flag = await posthog.createDraftFeatureFlag({
        key: s.flagKey,
        name: `${s.flagKey} (auto-created by PreHog)`,
        description: s.motivation,
        prUrl: pr.url,
      });
      created.push(flag);
      newState.created.push({ ...flag, planKey });
    } catch (err) {
      console.warn(`Failed to create feature flag "${s.flagKey}":`, err);
    }
  } else if (args.createResources) {
    // Defer creation pending user approval via PR label or comment reaction.
    pendingPermission = {
      kind: 'create_feature_flag',
      payload: {
        flagKey: s.flagKey,
        motivation: s.motivation,
        scope: s.scope,
      },
    };
  }

  const md = renderFlagsMarkdown({ suggestion: s, reasoning: value.reasoning, created, pendingPermission });

  const inlineSuggestions: InlineSuggestion[] = (value.inlineSuggestions ?? []).map((sug) => ({
    ...sug,
    reviewer: 'flags' as const,
  }));

  return {
    reviewer: 'flags',
    applicable: true,
    summary: value.reasoning,
    markdown: md,
    createdResources: created,
    pendingPermission,
    inlineSuggestions,
  };
}

function renderFlagsMarkdown(args: {
  suggestion: NonNullable<FlagLLMOutput['suggestion']>;
  reasoning: string;
  created: ReviewerOutput['createdResources'];
  pendingPermission?: ReviewerOutput['pendingPermission'];
}): string {
  const { suggestion: s, reasoning, created, pendingPermission } = args;
  const lines: string[] = ['### Feature flags'];
  if (reasoning) lines.push(`> ${reasoning.trim()}`);

  lines.push('', `- **Suggested flag:** \`${s.flagKey}\` (${s.scope.replace(/_/g, ' ')})`);
  lines.push(`- **Motivation:** ${s.motivation}`);

  if (s.registrationPoints.length) {
    lines.push(`- **Register in:**`);
    for (const r of s.registrationPoints) lines.push(`    - \`${r}\``);
  }

  if (s.gateSites.frontend.length || s.gateSites.backend.length) {
    lines.push(`- **Gate at:**`);
    for (const r of s.gateSites.frontend) lines.push(`    - frontend → \`${r}\``);
    for (const r of s.gateSites.backend) lines.push(`    - backend → \`${r}\``);
  }

  if (s.examplePatterns.length) {
    lines.push('', '<details><summary>Example patterns</summary>', '');
    for (const ex of s.examplePatterns) {
      lines.push('```', ex, '```');
    }
    lines.push('</details>');
  }

  if (created.length) {
    lines.push('', '**Created in PostHog (at 0% rollout, inactive)**');
    for (const c of created) lines.push(`- 🚩 [${c.name}](${c.url})`);
  } else if (pendingPermission) {
    lines.push(
      '',
      '> **Permission required.** I have NOT created this flag yet. To create it (inactive, at 0% rollout) add the label `prehog:create-flag` to this PR or reply `/prehog create-flag` and I will create it on the next run.',
    );
  }

  return lines.join('\n');
}
