import type { CreatedResource, PullRequestContext } from './types.js';

/**
 * Lightweight Slack helper used for two things:
 *
 * 1. Rendering an "opt-in" snippet in the PR comment when the customer has the
 *    PostHog Slack integration enabled. The user picks a channel from a list
 *    of suggested ones (we don't enumerate Slack itself in the action; we just
 *    show them how to do it via PostHog Subscriptions / Slack scheduled messages).
 *
 * 2. If a SLACK_BOT_TOKEN is provided and the PR author explicitly approves via
 *    PR comment (`/autonomy notify #channel-name`), the orchestrator can use
 *    this to send a recap message later.
 */
export interface SlackOptInPlan {
  enabled: boolean;
  suggestedChannel: string;
  optInMarkdown: string;
}

export function buildSlackOptInPlan(args: {
  pr: PullRequestContext;
  createdResources: CreatedResource[];
  customerHasSlackIntegration: boolean;
  slackBotTokenAvailable: boolean;
}): SlackOptInPlan {
  const { pr, createdResources, customerHasSlackIntegration, slackBotTokenAvailable } = args;
  if (!customerHasSlackIntegration) {
    return { enabled: false, suggestedChannel: '', optInMarkdown: '' };
  }

  const suggestedChannel = suggestChannel(pr);

  const insightLinks = createdResources
    .filter((r) => r.kind === 'insight')
    .slice(0, 5)
    .map((r) => `[${r.name}](${r.url})`)
    .join(' • ');

  const lines = [
    '### Slack follow-up',
    `> Your PostHog project has Slack connected. I can drop a quick recap into a channel of your choice ~7 days after this PR merges, with how the new instrumentation is performing.`,
    '',
    `**Suggested channel:** \`${suggestedChannel}\``,
    '',
    'To opt in, reply to this comment with:',
    '',
    '```',
    `/autonomy notify #${suggestedChannel} 7d`,
    '```',
    '',
    insightLinks
      ? `_Recap would include results for: ${insightLinks}_`
      : '_Recap would include any insights/dashboards I create above._',
  ];

  if (!slackBotTokenAvailable) {
    lines.push(
      '',
      '_Note: this action does not currently have a `SLACK_BOT_TOKEN` configured, so the recap will be delivered via PostHog Subscriptions instead of a direct Slack message._',
    );
  }

  return {
    enabled: true,
    suggestedChannel,
    optInMarkdown: lines.join('\n'),
  };
}

function suggestChannel(pr: PullRequestContext): string {
  // Best-effort: derive from PR labels, base branch, or repo name.
  const repoSlug = pr.repo.toLowerCase();
  if (repoSlug === 'posthog') return 'product-internal';
  return `${repoSlug}-launches`;
}
