import { loadConfig } from './config.js';
import { ClaudeClient } from './claude.js';
import { GitHubClient } from './github.js';
import { PostHogClient } from './posthog/client.js';
import { summarizeFeature } from './analysis/semantic.js';
import { runAnalyticsReviewer } from './analysis/analytics-reviewer.js';
import { runInstrumentationReviewer } from './analysis/instrumentation-reviewer.js';
import { runFlagsReviewer } from './analysis/flags-reviewer.js';
import { buildSlackOptInPlan } from './slack.js';
import { renderFinalComment } from './comment.js';
import {
  renderSuggestionCommentBody,
  suggestionFingerprint,
  validateSuggestions,
} from './inline-suggestions.js';
import { renderPromotionMarkdown, runPromotion, type PromotionResult } from './promote.js';
import { emptyState, parseStateFromComment, type ReviewState } from './state.js';
import { versionTag } from './version.js';
import type { ReviewerName } from './config.js';
import type { InlineSuggestion, ReviewerOutput } from './types.js';

const COMMENT_MARKER = '<!-- prehog -->';

async function main(): Promise<void> {
  // First line of every run — pin this in your eyes when verifying which
  // version of the action is deployed (or `grep "prehog v"
  // run.log` after the fact).
  console.log(`[prehog] ${versionTag()}`);

  const config = loadConfig();

  const github = new GitHubClient(config.githubToken, config.githubRepository);
  const claude = new ClaudeClient(config.anthropicApiKey, config.model);
  const posthog = PostHogClient.fromConfig({
    host: config.posthogHost,
    apiKey: config.posthogPersonalApiKey,
    projectId: config.posthogProjectId,
    mcp: config.posthogMcpUrl
      ? { url: config.posthogMcpUrl, token: config.posthogMcpToken ?? config.posthogPersonalApiKey }
      : undefined,
  });

  console.log(`[prehog] Loading PR ${config.githubRepository}#${config.githubPrNumber}`);
  const pr = await github.getPullRequestContext(config.githubPrNumber);
  console.log(`[prehog] PR has ${pr.changedFiles.length} changed files`);

  console.log('[prehog] Reading prior bot comment (if any) for state recovery');
  const priorCommentBody = await github.getExistingReviewComment(pr.number, COMMENT_MARKER);
  const priorState: ReviewState = parseStateFromComment(priorCommentBody);
  const newState: ReviewState = emptyState();
  if (priorState.created.length) {
    console.log(`[prehog] Recovered ${priorState.created.length} prior resource(s) from comment`);
  }

  // Promote-on-merge: pre-register the events/properties the bot suggested
  // during review that now appear in the merged diff. Runs BEFORE the
  // reviewer so the registered events show up in findExistingEvents() and
  // the reviewer's findMissingEntities() check passes — that's what causes
  // affected insights to lose their "⏳ Waiting for X" prefix on this pass.
  let promotionResult: PromotionResult | null = null;
  if (config.prMerged) {
    console.log('[prehog] PR is merged — running promote-on-merge pass');
    const suggestedEventNames = new Set(priorState.suggestedEvents ?? []);
    const suggestedPropertyNames = new Set(priorState.suggestedProperties ?? []);
    if (suggestedEventNames.size === 0 && suggestedPropertyNames.size === 0) {
      console.log('[prehog] No prior suggestions in state — skipping promotion');
    } else {
      console.log(
        `[prehog] Prior suggestions: ${suggestedEventNames.size} event(s), ${suggestedPropertyNames.size} property/ies`,
      );
      promotionResult = await runPromotion({
        pr,
        posthog,
        priorSuggestions: { suggestedEventNames, suggestedPropertyNames },
      });
      console.log(
        `[prehog] Promotion: registered ${promotionResult.registeredEvents.length} event(s), ${promotionResult.registeredProperties.length} property/ies, ${promotionResult.notLanded.length} not landed`,
      );
      // Record the merge sha + timestamp on newState for re-run idempotency.
      newState.mergeCommitSha = pr.headSha;
      newState.promotedAt = new Date().toISOString();
    }
  }

  console.log('[prehog] Detecting customer product mix');
  const productMix = await posthog.detectCustomerProductMix();
  console.log('[prehog] Product mix:', productMix.enabled);

  console.log('[prehog] Summarizing feature semantically');
  const summary = await summarizeFeature(claude, pr);
  console.log(
    `[prehog] Feature: ${summary.oneLine} (size=${summary.size}, surfaces=${summary.surfaces.join(',')})`,
  );

  const labels = await github.getLabels(pr.number);
  const userApprovedFlagCreation = labels.includes('prehog:create-flag');

  const enabled = new Set<ReviewerName>(config.enabledReviewers);
  const outputs: ReviewerOutput[] = [];

  if (enabled.has('analytics')) {
    console.log('[prehog] Running analytics reviewer');
    outputs.push(
      await runAnalyticsReviewer({
        claude,
        github,
        posthog,
        pr,
        summary,
        productMix,
        insightBudgetSmall: config.insightBudgetSmall,
        insightBudgetLarge: config.insightBudgetLarge,
        createResources: config.createResources,
        priorState,
        newState,
      }),
    );
  }

  for (const kind of ['logs', 'errors', 'llm'] as const) {
    if (!enabled.has(kind)) continue;
    console.log(`[prehog] Running ${kind} reviewer`);
    outputs.push(
      await runInstrumentationReviewer({ kind, claude, pr, summary, productMix }),
    );
  }

  if (enabled.has('flags')) {
    console.log('[prehog] Running feature flags reviewer');
    outputs.push(
      await runFlagsReviewer({
        claude,
        posthog,
        pr,
        summary,
        productMix,
        createResources: config.createResources,
        userApprovedFlagCreation,
        priorState,
        newState,
      }),
    );
  }

  const slackPlan = buildSlackOptInPlan({
    pr,
    createdResources: outputs.flatMap((o) => o.createdResources),
    customerHasSlackIntegration: productMix.slackIntegrationEnabled,
    slackBotTokenAvailable: Boolean(config.slackBotToken),
  });

  // Collect + validate inline suggestions. Anything that passes is posted as
  // a Greptile-style review-comment with a `suggestion` block; the rest get
  // dropped or fall back to the summary comment per reviewer's own markdown.
  const allSuggestions: InlineSuggestion[] = outputs.flatMap((o) => o.inlineSuggestions);
  console.log(`[prehog] Inline suggestions: ${allSuggestions.length} raw from reviewers`);
  let inlineReport = { posted: 0, dropped: 0, rejections: [] as Array<{ kind: string; reason: string }> };

  if (config.enableInlineSuggestions && allSuggestions.length > 0) {
    const alreadyPosted = new Set(priorState.postedSuggestions ?? []);
    const validated = validateSuggestions(allSuggestions, {
      pr,
      confidenceThreshold: config.suggestionConfidenceThreshold,
      alreadyPostedFingerprints: alreadyPosted,
    });

    const toPost = validated.filter((v) => v.valid).slice(0, config.suggestionMax);
    inlineReport.posted = toPost.length;
    inlineReport.dropped = validated.length - toPost.length;
    inlineReport.rejections = validated
      .filter((v) => !v.valid)
      .map((v) => ({ kind: v.kind, reason: v.rejection ?? 'unknown' }));

    console.log(`[prehog] Inline suggestions: ${toPost.length} valid, ${inlineReport.dropped} dropped`);
    for (const r of inlineReport.rejections) {
      console.log(`[prehog]   dropped: ${r.kind} — ${r.reason}`);
    }

    if (toPost.length > 0) {
      console.log(`[prehog] Posting ${toPost.length} inline suggestion(s)`);
      const reviewBody = `🦔 **PreHog** — ${toPost.length} inline suggestion${toPost.length === 1 ? '' : 's'} below. See the top-level comment for the full review.`;
      try {
        await github.postReviewWithSuggestions({
          prNumber: pr.number,
          headSha: pr.headSha,
          body: reviewBody,
          comments: toPost.map((s) => ({
            path: s.path,
            line: s.endLine,
            side: 'RIGHT' as const,
            ...(s.endLine !== s.startLine
              ? { start_line: s.startLine, start_side: 'RIGHT' as const }
              : {}),
            body: renderSuggestionCommentBody(s),
          })),
        });
        // Persist fingerprints for re-run dedupe.
        newState.postedSuggestions = Array.from(
          new Set([...(priorState.postedSuggestions ?? []), ...toPost.map((s) => suggestionFingerprint(s))]),
        );
      } catch (err) {
        console.warn('[prehog] Failed to post inline review:', (err as Error).message);
      }
    } else {
      // Carry forward prior fingerprints unchanged so re-runs stay idempotent.
      newState.postedSuggestions = priorState.postedSuggestions ?? [];
    }
  } else {
    newState.postedSuggestions = priorState.postedSuggestions ?? [];
  }

  const commentBody = renderFinalComment({
    pr,
    summary,
    productMix,
    outputs,
    slackPlan,
    state: newState,
    inlineReport,
    promotionMarkdown: promotionResult ? renderPromotionMarkdown(promotionResult) : undefined,
  });

  console.log('[prehog] Posting / updating PR comment');
  await github.upsertReviewComment(pr.number, commentBody, COMMENT_MARKER);

  console.log('[prehog] Done.');
}

main().catch((err) => {
  console.error('[prehog] fatal:', err);
  process.exitCode = 1;
});
