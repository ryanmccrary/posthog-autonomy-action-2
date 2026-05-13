import type { ClaudeClient } from '../claude.js';
import { loadPrompt } from '../prompts.js';
import { stripUntrustedMarkdown, stripUntrustedMarkdownAll } from '../sanitize.js';
import type { FeatureSummary, PullRequestContext } from '../types.js';

/**
 * Produce a structured FeatureSummary by feeding the PR title/body + bounded
 * diff to Claude. This summary is the SHARED input every downstream reviewer
 * reads, so we run it once and pass the result around.
 */
export async function summarizeFeature(
  claude: ClaudeClient,
  pr: PullRequestContext,
): Promise<FeatureSummary> {
  const system = await loadPrompt('feature-summary.md');

  const user = [
    `Repository: ${pr.owner}/${pr.repo}`,
    `PR #${pr.number}: ${pr.title}`,
    pr.body ? `PR description:\n${pr.body}` : 'PR has no description.',
    '',
    'Changed files (path | status | +adds -dels):',
    ...pr.changedFiles
      .slice(0, 80)
      .map((f) => `  ${f.path} | ${f.status} | +${f.additions} -${f.deletions}`),
    pr.changedFiles.length > 80 ? `  ...and ${pr.changedFiles.length - 80} more` : '',
    '',
    'Unified diff (truncated):',
    '```diff',
    pr.unifiedDiff,
    '```',
  ]
    .filter(Boolean)
    .join('\n');

  const { value } = await claude.structured<FeatureSummary>({
    system,
    user,
    maxTokens: 1500,
  });

  // Security: strip markdown image syntax / raw HTML / dangerous URL schemes
  // from every model-emitted prose field BEFORE the summary fans out to
  // downstream reviewers and the comment renderer (audit Finding 1).
  return {
    ...value,
    oneLine: stripUntrustedMarkdown(value.oneLine),
    narrative: stripUntrustedMarkdown(value.narrative),
    rationale: stripUntrustedMarkdown(value.rationale),
    capabilities: stripUntrustedMarkdownAll(value.capabilities ?? []),
    surfaces: stripUntrustedMarkdownAll(value.surfaces ?? []),
    extendsFeatures: stripUntrustedMarkdownAll(value.extendsFeatures ?? []),
  };
}
