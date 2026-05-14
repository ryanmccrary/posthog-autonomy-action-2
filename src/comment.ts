import { stripUntrustedMarkdown, stripUntrustedMarkdownAll } from './sanitize.js';
import { serializeStateBlock, type ReviewState } from './state.js';
import type { SlackOptInPlan } from './slack.js';
import type {
  CustomerProductMix,
  FeatureSummary,
  PullRequestContext,
  ReviewerOutput,
} from './types.js';

export interface InlineSuggestionReport {
  posted: number;
  dropped: number;
  rejections: Array<{ kind: string; reason: string }>;
}

export function renderFinalComment(args: {
  pr: PullRequestContext;
  summary: FeatureSummary;
  productMix: CustomerProductMix;
  outputs: ReviewerOutput[];
  slackPlan: SlackOptInPlan;
  state: ReviewState;
  inlineReport?: InlineSuggestionReport;
  /**
   * Optional rendered markdown block from the promote-on-merge pass.
   * Inserted near the top of the comment (after the feature summary) so
   * the reader immediately sees what got registered. The orchestrator
   * passes `renderPromotionMarkdown(promotionResult)`; omitted on normal
   * non-merge runs.
   */
  promotionMarkdown?: string;
}): string {
  const { pr, productMix, outputs, slackPlan, state, inlineReport, promotionMarkdown } = args;

  // Security (audit Finding 1): apply the markdown/HTML/script sanitizer at
  // the rendering boundary in addition to the reviewer-level sanitization in
  // src/analysis/semantic.ts. Defence-in-depth: if a future reviewer adds a
  // new prose field and forgets to sanitize upstream, the renderer still
  // strips dangerous patterns before the body reaches GitHub.
  const summary: FeatureSummary = {
    ...args.summary,
    oneLine: stripUntrustedMarkdown(args.summary.oneLine),
    narrative: stripUntrustedMarkdown(args.summary.narrative),
    rationale: stripUntrustedMarkdown(args.summary.rationale),
    capabilities: stripUntrustedMarkdownAll(args.summary.capabilities ?? []),
    surfaces: stripUntrustedMarkdownAll(args.summary.surfaces ?? []),
    extendsFeatures: stripUntrustedMarkdownAll(args.summary.extendsFeatures ?? []),
  };

  const applicable = outputs.filter((o) => o.applicable);
  const skipped = outputs.filter((o) => !o.applicable);

  const lines: string[] = [];
  lines.push('## 🦔 PreHog Review');
  lines.push('');
  lines.push(
    `**Feature:** ${summary.oneLine}  ·  **Size:** \`${summary.size}\`  ·  **Surfaces:** ${summary.surfaces.map((s) => `\`${s}\``).join(', ') || '—'}`,
  );
  lines.push('');
  lines.push(`> ${summary.narrative.trim().replace(/\n/g, ' ')}`);
  lines.push('');

  const enabledList = Object.entries(productMix.enabled)
    .filter(([, v]) => v)
    .map(([k]) => `\`${k}\``)
    .join(', ');
  lines.push(`<sub>Enabled PostHog products on this project: ${enabledList || '_none detected_'}</sub>`);
  lines.push('');

  // Promote-on-merge surfacing — appears right after the feature summary
  // so the reader doesn't have to scroll past suggestions they already
  // acted on to find what got registered.
  if (promotionMarkdown) {
    lines.push(promotionMarkdown);
    lines.push('');
  }

  if (applicable.length === 0) {
    lines.push(
      '_No instrumentation suggestions for this PR. The feature summary suggests none of the PostHog products are relevant to the changes in this diff._',
    );
  }

  if (inlineReport && inlineReport.posted > 0) {
    lines.push(
      `> ✨ Posted **${inlineReport.posted}** inline suggestion${inlineReport.posted === 1 ? '' : 's'} as a review on the **Files changed** tab. Click "Apply suggestion" to commit any of them.`,
    );
    lines.push('');
  }

  for (const out of applicable) {
    lines.push(out.markdown);
    lines.push('');
  }

  if (inlineReport && inlineReport.dropped > 0) {
    lines.push('<details><summary>Inline suggestions dropped</summary>');
    lines.push('');
    lines.push(
      `${inlineReport.dropped} additional suggestion(s) were dropped because they were below the confidence threshold or did not anchor inside a changed hunk of the diff. Detail below — these are in the summary above instead.`,
    );
    lines.push('');
    for (const r of inlineReport.rejections.slice(0, 20)) {
      lines.push(`- **${r.kind}** — ${r.reason}`);
    }
    lines.push('</details>');
    lines.push('');
  }

  if (slackPlan.enabled) {
    lines.push(slackPlan.optInMarkdown);
    lines.push('');
  }

  if (skipped.length > 0) {
    lines.push('<details><summary>Reviewers skipped</summary>');
    lines.push('');
    for (const s of skipped) lines.push(`- **${s.reviewer}** — ${s.summary}`);
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  lines.push(
    `<sub>PR: [#${pr.number}](${pr.url}) · model: \`claude-opus-4-7\` · this is an auto-generated review; reply with /prehog help for options.</sub>`,
  );

  // State block — single line, parseable on re-run. Always last so the upsert
  // marker can find it without colliding with other HTML comments.
  lines.push('');
  lines.push(serializeStateBlock(state));

  return lines.join('\n');
}
