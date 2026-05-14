import { Octokit } from '@octokit/rest';
import type { ChangedFile, PullRequestContext } from './types.js';

/** Max characters of unified diff we feed to Claude in one go. */
const DIFF_BUDGET = 60_000;
/** Files matching these patterns rarely contain feature logic — drop their patches. */
const NOISE_PATTERNS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)Cargo\.lock$/,
  /\.min\.(js|css)$/,
  /\.snap$/,
  /(^|\/)__snapshots__\//,
  /(^|\/)\.po(t)?$/,
  /(^|\/)CHANGELOG\.md$/,
];

export class GitHubClient {
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;

  constructor(token: string, repository: string) {
    this.octokit = new Octokit({ auth: token });
    const [owner, repo] = repository.split('/', 2);
    if (!owner || !repo) {
      throw new Error(`Invalid repository "${repository}", expected owner/repo`);
    }
    this.owner = owner;
    this.repo = repo;
  }

  async getPullRequestContext(prNumber: number): Promise<PullRequestContext> {
    const { data: pr } = await this.octokit.pulls.get({
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
    });

    const files = await this.octokit.paginate(this.octokit.pulls.listFiles, {
      owner: this.owner,
      repo: this.repo,
      pull_number: prNumber,
      per_page: 100,
    });

    const changedFiles: ChangedFile[] = files.map((f) => ({
      path: f.filename,
      status: f.status as ChangedFile['status'],
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
    }));

    const unifiedDiff = buildBoundedDiff(changedFiles, DIFF_BUDGET);

    return {
      owner: this.owner,
      repo: this.repo,
      number: prNumber,
      title: pr.title,
      body: pr.body ?? '',
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      author: pr.user?.login ?? 'unknown',
      url: pr.html_url,
      changedFiles,
      unifiedDiff,
    };
  }

  /**
   * Fetch the raw contents of a single file at the PR head sha. Used by reviewers
   * to peek at neighbouring tracking code that the diff itself may not include.
   */
  async getFileAtSha(path: string, sha: string): Promise<string | null> {
    try {
      const res = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path,
        ref: sha,
      });
      if (Array.isArray(res.data) || res.data.type !== 'file') return null;
      const data = res.data as { content?: string; encoding?: string };
      if (!data.content) return null;
      return Buffer.from(data.content, (data.encoding ?? 'base64') as BufferEncoding).toString('utf8');
    } catch {
      return null;
    }
  }

  /**
   * Search the repository for occurrences of a string (e.g. `posthog.capture('event_name'`).
   * GitHub code search is rate-limited; reviewers should call sparingly.
   */
  async searchCode(query: string, maxResults = 20): Promise<Array<{ path: string; url: string }>> {
    try {
      const { data } = await this.octokit.search.code({
        q: `${query} repo:${this.owner}/${this.repo}`,
        per_page: maxResults,
      });
      return data.items.map((item) => ({ path: item.path, url: item.html_url }));
    } catch {
      return [];
    }
  }

  /**
   * Read the existing bot comment for this PR, if any. Used by the orchestrator
   * to recover persisted state (the prehog-state JSON block) before running
   * the reviewers, so re-runs can update rather than duplicate resources.
   */
  async getExistingReviewComment(prNumber: number, marker: string): Promise<string | null> {
    const comments = await this.octokit.paginate(this.octokit.issues.listComments, {
      owner: this.owner,
      repo: this.repo,
      issue_number: prNumber,
      per_page: 100,
    });
    // Security (audit Finding 3): only treat Bot-authored comments as a source
    // of recoverable prehog-state. Without this filter, any user could post
    // a comment containing the marker + a forged state block and have it
    // parsed as the bot's prior state.
    const match = selectBotComment(comments, marker);
    return match?.body ?? null;
  }

  /** Read the PR's labels — used to detect human approval for flag creation. */
  async getLabels(prNumber: number): Promise<string[]> {
    const res = await this.octokit.issues.listLabelsOnIssue({
      owner: this.owner,
      repo: this.repo,
      issue_number: prNumber,
    });
    return res.data.map((l) => l.name);
  }

  /**
   * Post a GitHub review with one or more line-anchored suggestion comments.
   * Event is COMMENT (not APPROVE/REQUEST_CHANGES) so the bot never blocks
   * merges. The `commit_id` is pinned to the PR's current head sha so the
   * suggestions stay anchored even if the PR is force-pushed later.
   */
  async postReviewWithSuggestions(args: {
    prNumber: number;
    headSha: string;
    body: string;
    comments: Array<{
      path: string;
      body: string;
      line: number;
      side?: 'RIGHT' | 'LEFT';
      start_line?: number;
      start_side?: 'RIGHT' | 'LEFT';
    }>;
  }): Promise<{ id: number; url: string }> {
    const res = await this.octokit.pulls.createReview({
      owner: this.owner,
      repo: this.repo,
      pull_number: args.prNumber,
      commit_id: args.headSha,
      event: 'COMMENT',
      body: args.body,
      comments: args.comments.map((c) => ({
        path: c.path,
        body: c.body,
        line: c.line,
        side: c.side ?? 'RIGHT',
        start_line: c.start_line,
        start_side: c.start_side,
      })),
    });
    return { id: res.data.id, url: res.data.html_url };
  }

  /** Upsert a single bot-owned PR comment so re-runs don't spam. */
  async upsertReviewComment(prNumber: number, body: string, marker: string): Promise<void> {
    const existing = await this.findCommentByMarker(prNumber, marker);
    const finalBody = `${body}\n\n${marker}`;
    if (existing) {
      await this.octokit.issues.updateComment({
        owner: this.owner,
        repo: this.repo,
        comment_id: existing.id,
        body: finalBody,
      });
    } else {
      await this.octokit.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: prNumber,
        body: finalBody,
      });
    }
  }

  private async findCommentByMarker(
    prNumber: number,
    marker: string,
  ): Promise<{ id: number } | null> {
    const comments = await this.octokit.paginate(this.octokit.issues.listComments, {
      owner: this.owner,
      repo: this.repo,
      issue_number: prNumber,
      per_page: 100,
    });
    const match = selectBotComment(comments, marker);
    return match ? { id: match.id } : null;
  }
}

/**
 * Shape we need from a GitHub Issue Comment to decide whether it's a
 * candidate for the bot's "upsert" target. Defined here (rather than relying
 * on Octokit's full response type) so the helper can be unit-tested without
 * mocking the entire Octokit surface.
 */
export interface CommentForSelection {
  id: number;
  body?: string | null | undefined;
  user?: { type?: string; login?: string } | null | undefined;
}

/**
 * Pure helper that picks the bot's own comment out of a PR's comment list,
 * enforcing **two** gates:
 *
 *   1. The marker substring must be in the comment body (existing behaviour).
 *   2. The comment's author MUST be a GitHub Bot (`user.type === 'Bot'`).
 *
 * Fixes security-audit Finding 3 — without (2), ANY user with PR-comment
 * access could post a comment containing the marker and a forged
 * `prehog-state` JSON block, and the bot would parse the attacker's state
 * as if it were its own. The default GitHub-Actions token authenticates as
 * `github-actions[bot]` (type=Bot), so legitimate bot comments still match.
 *
 * If we later support GitHub-App-installed bots or alternative posting
 * identities, callers can pass an explicit allowlist via a future
 * `allowedLogins` parameter. For now, the type=Bot filter is sufficient
 * because regular users cannot register as Bot accounts.
 */
export function selectBotComment(
  comments: readonly CommentForSelection[],
  marker: string,
): CommentForSelection | null {
  for (const c of comments) {
    if (c.user?.type !== 'Bot') continue;
    const body = c.body ?? '';
    if (body.includes(marker)) return c;
  }
  return null;
}

function buildBoundedDiff(files: ChangedFile[], budget: number): string {
  const usefulFiles = files.filter((f) => !NOISE_PATTERNS.some((re) => re.test(f.path)));
  // Prefer larger-diff files since they're more likely to define the feature surface.
  usefulFiles.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));

  let total = 0;
  const chunks: string[] = [];
  for (const f of usefulFiles) {
    if (!f.patch) continue;
    const header = `\n--- ${f.path} (${f.status} +${f.additions} -${f.deletions}) ---\n`;
    const piece = header + f.patch;
    if (total + piece.length > budget) {
      chunks.push(`${header}[diff truncated to fit budget]`);
      break;
    }
    chunks.push(piece);
    total += piece.length;
  }
  return chunks.join('\n');
}
