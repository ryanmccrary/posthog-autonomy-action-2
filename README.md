# PostHog PR Autonomy Bot

A Greptile-style PR reviewer for PostHog — but specialized for **product
autonomy**. It reads each PR semantically, figures out what feature is being
added, and proactively:

1. Suggests missing PostHog instrumentation across **analytics**, **logs**,
   **error tracking**, **LLM analytics**, and **feature flags**.
2. Posts **line-anchored ` ```suggestion ` blocks** in the Files-changed tab
   for the mechanical edits (extend a `posthog.capture(...)` with a new
   property, insert a log line, wrap a fetch with `capture_exception`, wrap
   an LLM call with the PostHog SDK, register a flag constant, wrap a JSX
   block in `<FlaggedFeature>`) so reviewers can one-click Apply them.
3. Creates the right PostHog resources on your behalf — insights, dashboards,
   and (with explicit approval) draft feature flags.
4. Offers a Slack follow-up that pings a channel with the new feature's metrics
   once data has flowed in.

It's installed as a single GitHub Action and posts at most two artefacts per PR:
a single upserted summary comment (with the strategic plan, insight links,
dashboard, flag flow, and Slack opt-in) plus one GitHub review carrying the
high-confidence inline suggestions.

---

## What it actually does (with examples)

Given the [scheduled workflows PR](https://github.com/PostHog/posthog/pull/54115),
the bot looks at existing tracking calls in the repo, finds the `hog_flow_created`
event in your project's PostHog schema, and produces something like:

> **Suggested events**
> - **`hog_flow_created`** _(extend existing, confidence 90%)_ — when the user
>   persists a workflow, include the trigger type so we can slice activations.
>   - `trigger_type` _(String)_ — one of `event`, `batch`, `schedule`
> - **`hog_flow_schedule_fired`** _(new event, confidence 75%)_ — when the
>   scheduler enqueues a scheduled workflow run.
>   - `flow_id` _(String)_, `recurrence` _(String)_
>
> **Created in PostHog**
> - 📊 Dashboard: [Workflows — auto-generated](https://...)
> - 📈 Insight: [Workflows activated by trigger type, over time](https://...)
> - 📈 Insight: [Workflows run per week with `batch` triggers](https://...)
> - 📈 Insight: [Scheduled workflow runs, weekly](https://...)

The same approach runs for logs (suggests `info` / `error` log lines with a
service tag), error tracking (flags caught-but-not-reported failure modes),
LLM analytics (proposes wrapping new LLM call sites), and feature flags (only
when the PR genuinely needs gradual rollout or per-org gating).

Additionally, for each suggestion above where the bot can locate the exact
line(s) in the diff and produce a concrete patch, it posts a GitHub review
comment with a ` ```suggestion ` block on those lines. For the
`hog_flow_created` extension, that looks like an inline suggestion on the
existing capture call that adds the `trigger_type` property next to the
existing ones — one click to apply. Low-confidence or wrong-place suggestions
stay in the summary above (and are listed under "Inline suggestions dropped"
with a reason).

---

## Architecture

```text
GitHub PR  →  GH client (diff + prior comment state)
                     │
                     ▼
                Semantic summary (single Claude call → FeatureSummary)
                     │
        ┌────────────┼────────────┬───────────────┬──────────────┐
        ▼            ▼            ▼               ▼              ▼
   Analytics      Logs         Errors        LLM analytics    Feature flags
        │            │            │               │              │
        ▼                                                        ▼
  PostHog client (MCP-first, REST-fallback)              draft flag (gated)
        │
        ▼
  insights / dashboards (create / update / leave-alone vs prior state)
        │                                                       │
        └─┬─────────────────────────────────────────────────────┘
          │                                            ╲
          │ each reviewer also yields                   ╲
          │ zero-or-more inlineSuggestions               ╲
          ▼                                              ▼
  Summary comment renderer                       Inline review poster
  (one upserted issue comment with               (one GitHub review with
   strategic plan + state JSON +                  N line-anchored
   "X dropped" disclosure)                        `suggestion` blocks)
          │                                              │
          └──────────────────────┬───────────────────────┘
                                 ▼
                         Slack opt-in (if customer has Slack)
```

Every reviewer reads the same `FeatureSummary` so we only pay the diff-reading
cost once.

Each reviewer returns:
- A `markdown` block for the strategic part of its analysis (rendered into the
  summary comment).
- A list of `createdResources` (insights / dashboards / draft flags it created
  or recovered from prior state).
- Zero or more `inlineSuggestions` — line-anchored, kind-tagged
  ` ```suggestion ` payloads with a self-rated `confidence`.

Reviewers short-circuit if the customer's project doesn't have that PostHog
product enabled OR if the summary doesn't consider it relevant.

### MCP-first, REST-compatible

Every PostHog call goes through a transport stack:

1. **MCP transport** (default). JSON-RPC against the PostHog remote MCP at
   `https://mcp.posthog.com/mcp`. Tool names map 1:1 to the PostHog MCP
   surface — `insight-create`, `insight-update`, `dashboard-create`,
   `create-feature-flag`, `event-definition-list`, etc.
2. **REST transport** (fallback). Direct PostHog REST API. Used when the MCP
   server doesn't advertise the tool, errors, or isn't configured.

The two transports live in `src/posthog/transports.ts`. The unified client in
`src/posthog/client.ts` wraps both — reviewers call e.g. `posthog.createInsight(...)`
and don't care which transport actually served the request.

Set `POSTHOG_MCP_URL=""` in the action inputs / `.env` to disable the MCP
attempt and go straight to REST. Self-hosted PostHog deployments can point
this at their own MCP endpoint.

### Idempotent re-runs

The bot writes a small JSON state block at the bottom of its own PR comment:

```html
<!-- autonomy-state:{"version":1,"created":[{"kind":"insight","id":42,"name":"…","url":"…","planKey":"workflows/activations-by-trigger","queryHash":"…"}, …]} -->
```

On the next run, the orchestrator reads that block and passes the prior state
to each reviewer. For every newly-planned insight:

- **`planKey` matches AND `queryHash` matches** → leave the existing insight
  alone, re-link it in the comment (`↔ unchanged`).
- **`planKey` matches AND `queryHash` changed** → `PATCH` the existing insight
  via `insight-update`, preserving its `short_id`, dashboard tile placement
  and shared links (`✏️ updated`).
- **`planKey` is new** → create the insight, attach to dashboard if one
  exists (`✨ created`).
- **`planKey` is in state but no longer in the plan** → leave the resource
  untouched and surface it under "previously created, no longer in plan" so
  the author can decide whether to delete it themselves.

The same shape applies to dashboards. Feature flags are never auto-updated;
once recorded in state we just re-link.

`planKey` is a stable kebab-case slug Claude is asked to generate
deterministically (e.g. `workflows/activations-by-trigger`,
`tracing/trace-opens-trend`). `queryHash` is a sha1 over the canonicalised
insight query JSON.

### Greptile-style inline suggestion blocks

Each reviewer can additionally emit line-anchored ` ```suggestion ` payloads
that get posted as GitHub PR review comments. Reviewers see them on the
**Files changed** tab with an "Apply suggestion" button.

**Suggestion `kind`s the bot can emit today:**

| Reviewer | `kind`s |
| --- | --- |
| analytics | `extend_existing_capture`, `new_capture` |
| logs | `log_insertion` |
| errors | `capture_exception_wrap` |
| llm | `llm_wrapper` |
| flags | `flag_constant_register`, `flag_frontend_gate`, `flag_backend_gate` |

**Three gates before a suggestion is posted (`src/inline-suggestions.ts`):**

1. **Confidence threshold.** Claude self-rates each suggestion 0..1. Anything
   below `suggestion-confidence-threshold` (default `0.65`) is dropped from
   the inline review and surfaced under "Inline suggestions dropped" in the
   summary comment with the rejection reason.
2. **Anchor validation.** Every suggestion's `path` + `startLine..endLine` is
   validated against the PR's actual diff hunks via `parse-diff`. Out-of-hunk
   anchors are rejected — they'd otherwise render at the top of the file
   instead of inline, which is loud and unhelpful.
3. **Cross-run dedupe.** A fingerprint per suggestion (`kind | path | line
   range | body prefix`) is persisted in the autonomy-state JSON block.
   Subsequent runs on the same PR don't re-post suggestions whose fingerprint
   already shipped. The fingerprint includes a prefix of the suggestion body
   so materially-different proposals do still post.

There's also a hard cap (`suggestion-max`, default `12`) on the number of
inline comments posted per review.

**What stays in the summary instead:**

- The full feature-flag flow narrative (multi-file: constant registration,
  FE gate, BE gate, motivation, scope) — too long to fit one hunk.
- The insight plan + dashboard links + Slack opt-in.
- Any low-confidence or non-anchorable suggestions.

**Disable inline suggestions:** set `enable-inline-suggestions: 'false'` in
the action inputs. Everything falls back to the summary comment.

---

## Setup

### Required secrets / vars

| Name | Where | What |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | repo secret | Powers semantic analysis. |
| `POSTHOG_PERSONAL_API_KEY` | repo secret | Personal API key with the project scope. |
| `POSTHOG_HOST` | repo var | `https://us.posthog.com` or `https://eu.posthog.com` or your self-hosted host. |
| `POSTHOG_PROJECT_ID` | repo var | Numeric team / project id to scope reviews against. |
| `POSTHOG_MCP_URL` | repo var (optional) | MCP JSON-RPC endpoint. Default `https://mcp.posthog.com/mcp`. Set to `""` to skip MCP and use REST only. |
| `POSTHOG_MCP_TOKEN` | repo secret (optional) | Separate token for the MCP endpoint. Defaults to `POSTHOG_PERSONAL_API_KEY`. |
| `SLACK_BOT_TOKEN` | repo secret (optional) | Enables direct Slack delivery for the follow-up. |

### Install as a GitHub Action

In your target repo, add a workflow:

```yaml
# .github/workflows/posthog-autonomy.yml
name: PostHog Autonomy Review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: PostHog/pr-autonomy-bot@main  # or pin to a specific SHA / tag
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          posthog-personal-api-key: ${{ secrets.POSTHOG_PERSONAL_API_KEY }}
          posthog-host: ${{ vars.POSTHOG_HOST }}
          posthog-project-id: ${{ vars.POSTHOG_PROJECT_ID }}
          slack-bot-token: ${{ secrets.SLACK_BOT_TOKEN }}
          # Inline suggestion knobs (optional — defaults shown):
          enable-inline-suggestions: 'true'
          suggestion-confidence-threshold: '0.65'
          suggestion-max: '12'
```

See `action.yml` for the full list of inputs and defaults.

---

## Local development

```bash
npm install
cp .env.example .env       # fill in ANTHROPIC_API_KEY at minimum

# Run against the bundled fixture, no PostHog writes:
npm run local -- --dry

# Real PR, dry PostHog (needs GITHUB_TOKEN with read access):
npm run local -- --pr 54115 --repo PostHog/posthog --dry

# Full integration — will create insights / dashboards in PostHog:
npm run local -- --pr 54115
```

The runner prints the `FeatureSummary` JSON and the final PR comment markdown
to stdout. Use `--dry` while iterating on prompts.

### Prompt files

The reviewer prompts live in `src/prompts/*.md` and are loaded at runtime — you
can edit them and re-run `npm run local` without rebuilding. They are the
biggest lever on review quality.

- `feature-summary.md` — the structured PR-understanding prompt (drives
  everything downstream).
- `analytics.md` — events + insight plans.
- `logs.md`, `errors.md`, `llm.md` — instrumentation suggestions.
- `flags.md` — biased toward "no flag needed"; gates explicit permission ask.

---

## How approvals work

The bot **never auto-creates feature flags** without the PR author confirming.
On a PR where a flag is recommended, the comment includes:

> **Permission required.** I have NOT created this flag yet. To create it
> (inactive, at 0% rollout) add the label `autonomy-bot:create-flag` to this
> PR or reply `/autonomy create-flag` and I will create it on the next run.

For analytics, the bot **does** auto-create insights and dashboards by default —
they're side-effect-free (no production impact, can be deleted) and they're the
core value proposition. Set `create-resources: 'false'` in the action inputs if
you want to flip this to suggestion-only.

---

## PostHog surface used

The client at `src/posthog/client.ts` calls into both transports. Each
operation maps to a single MCP tool name (preferred) and a REST fallback:

| Operation | MCP tool | REST fallback |
| --- | --- | --- |
| Detect analytics | `event-definition-list` | `GET /api/projects/:id/event_definitions/` |
| List event properties | `property-definition-list` | `GET /api/projects/:id/property_definitions/` |
| Detect feature flags | `feature-flag-get-all` | `GET /api/projects/:id/feature_flags/?limit=1` |
| Detect error tracking | `query-error-tracking-issues-list` | `GET /api/projects/:id/error_tracking/issues/?limit=1` |
| Detect logs | `logs-count` | `GET /api/environments/:id/logs/?limit=1` |
| Detect surveys / experiments | `surveys-get-all` / `experiment-get-all` | corresponding REST |
| Detect Slack integration | `integrations-list` | `GET /api/projects/:id/integrations/` |
| Create insight | `insight-create` | `POST /api/projects/:id/insights/` |
| Update insight (re-run) | `insight-update` | `PATCH /api/projects/:id/insights/:id/` |
| Create dashboard | `dashboard-create` | `POST /api/projects/:id/dashboards/` |
| Attach insight to dashboard | `dashboard-update` | `PATCH /api/projects/:id/insights/:id/` |
| Create draft feature flag | `create-feature-flag` | `POST /api/projects/:id/feature_flags/` |

The transport stack tries MCP first per-call and transparently falls back to
REST when the tool isn't advertised or the MCP request errors. Reviewers
neither know nor care which path served them.

---

## What's intentionally NOT in the MVP

- Scheduling the actual Slack follow-up delivery. We render the opt-in
  message; delivering the recap 7 days later is a separate cron path
  (PostHog Subscriptions is the lowest-cost option).
- Auto-deletion of obsolete resources. Re-runs detect when a previously
  auto-created resource is no longer in the current plan and surface it under
  "previously created, no longer in plan" — but they never auto-delete. The
  bot only ever creates, updates, or leaves alone.
- **Per-`kind` validation of inline-suggestion code bodies.** Today an inline
  suggestion's confidence + anchor are gated, but the suggestion's actual
  text is not parsed for "this looks like a legitimate one-line capture call,
  not arbitrary code." Tracked as Finding 2 from `/security-audit` — to be
  addressed in a follow-up PR. Until then, treat inline suggestions like any
  other AI-generated diff: read before clicking Apply. Set
  `enable-inline-suggestions: 'false'` to disable until the validator lands.

### Security posture

This bot is an AI agent with all three legs of the "lethal trifecta" — it
reads private repo + PostHog data, it consumes attacker-influenceable content
(the PR diff), and it acts externally (creates PostHog resources, posts
review comments). We've run our own `/security-audit` against it and fixed:

- **Finding 1 (High):** model-emitted prose is sanitized at two boundaries
  (`src/sanitize.ts` → `stripUntrustedMarkdown` in each reviewer and inside
  `renderFinalComment`) so prompt-injection-driven markdown image references
  can't exfil bot context via GitHub's Camo proxy on reviewer page loads.
- **Finding 3 (Medium):** the bot's prior-state JSON block is only recovered
  from comments authored by a `Bot` user (`src/github.ts → selectBotComment`).
  Without this, any commenter could pre-seed forged state to suppress or
  redirect the bot's behaviour on a PR.

15 reproducer tests in `src/sanitize.test.ts` and `src/select-bot-comment.test.ts`
demonstrate the fixes — run them with `npm run test`.

---

## Layout

```
src/
├── index.ts                            # GitHub Action entry — orchestrator
├── config.ts                           # zod-validated env loader (MCP url, REST creds, suggestion knobs)
├── types.ts                            # shared types (FeatureSummary, InlineSuggestion, etc.)
├── state.ts                            # parse/serialize autonomy-state + suggestion fingerprints
├── claude.ts                           # Anthropic wrapper (prompt caching, JSON parse)
├── github.ts                           # PR diff, comment upsert, review-with-suggestions, selectBotComment
├── comment.ts                          # summary comment renderer (embeds state block + sanitizes)
├── slack.ts                            # Slack opt-in markdown
├── sanitize.ts                         # stripUntrustedMarkdown — closes prompt-injection exfil
├── inline-suggestions.ts               # validation + fingerprint + GitHub review-comment rendering
├── prompts.ts                          # runtime markdown prompt loader (works bundled or from source)
├── posthog/
│   ├── transports.ts                   # MCP (JSON-RPC) + REST transports
│   └── client.ts                       # MCP-first PostHog client (create / update / etc.)
├── analysis/
│   ├── semantic.ts                     # FeatureSummary generator
│   ├── analytics-reviewer.ts           # events + insights + dashboards (idempotent, emits inline)
│   ├── instrumentation-reviewer.ts     # logs / errors / llm shared driver (emits inline)
│   └── flags-reviewer.ts               # permission-gated flag suggestion (emits inline)
├── prompts/                            # markdown prompts loaded at runtime
├── sanitize.test.ts                    # reproducer tests for security-audit Finding 1
└── select-bot-comment.test.ts          # reproducer tests for security-audit Finding 3
scripts/local-run.ts                    # dev runner (--dry, --pr, --no-mcp, --prior-state)
fixtures/                               # fixture PRs for local-run
action.yml                              # GitHub Action metadata
.github/workflows/pr-review.yml         # sample consumer workflow
```
