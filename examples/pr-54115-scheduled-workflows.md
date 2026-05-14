# Example output — PR #54115 (scheduled workflows)

What the bot would post on [PostHog/posthog#54115](https://github.com/PostHog/posthog/pull/54115).
Generated with `npm run local -- --dry` (the LLM portions are illustrative; real
runs will vary).

---

## 🦔 PreHog Review

**Feature:** Adds `schedule` as a third workflow trigger type alongside `event` and `batch`  ·  **Size:** `medium`  ·  **Surfaces:** `workflows`, `hog_flows`, `scheduler`

> This PR extends the existing workflows surface with a recurring-schedule trigger. The HogFlow model gains a JSON `schedule` field; the query runner branches on `trigger_type == "schedule"`; the FE adds a `HogFlowSchedulePicker` and exposes the new option in the trigger selector.

<sub>Enabled PostHog products on this project: `product_analytics`, `logs`, `error_tracking`, `feature_flags`</sub>

### Product analytics
> Bias was toward extending `hog_flow_created` / `hog_flow_activated` with a `trigger_type` property rather than adding parallel events, since the existing events already fire from the same FE/BE paths.

**Suggested events**
- **`hog_flow_created`** _(extend `hog_flow_created`, confidence 92%)_ — fire the existing creation event, but with the new trigger type so we can slice activations.
    - `trigger_type` _(String)_ — one of `event`, `batch`, `schedule`
    - Fire from: `frontend/src/scenes/hog-flows/HogFlowSchedulePicker.tsx`
- **`hog_flow_activated`** _(extend `hog_flow_activated`, confidence 88%)_ — same dimension on activation.
    - `trigger_type` _(String)_ — mirrors the value on `hog_flow_created`
- **`hog_flow_schedule_fired`** _(new event, confidence 75%)_ — fires when the scheduler enqueues a workflow run.
    - `flow_id` _(String)_
    - `recurrence` _(String)_ — the cron / interval spec the user configured
    - Fire from: `posthog/hogql_queries/hog_flow_query_runner.py:_run_scheduled`

**Created in PostHog**
- 📊 Dashboard: [Workflows — auto-generated](https://us.posthog.com/project/0/dashboard/stub-workflows)
- 📈 Insight: [Workflows activated by trigger type, over time](https://us.posthog.com/project/0/insights/stub-workflows-activated)
- 📈 Insight: [Scheduled workflow runs, weekly](https://us.posthog.com/project/0/insights/stub-scheduled-runs)
- 📈 Insight: [Funnel: workflow_created → workflow_activated, by trigger type](https://us.posthog.com/project/0/insights/stub-funnel-trigger)

### Logs
> A new worker path (`_run_scheduled`) computes a next-fire time and enqueues — we should log the transition and any compute failures.

_Service tag: `workflows-scheduler`_

- **[INFO]** `posthog/hogql_queries/hog_flow_query_runner.py:_run_scheduled` — Scheduled workflow enqueued
    - properties: flow_id, next_fire_at, recurrence
    - _Marks the state transition so on-call can correlate with subsequent runs._
- **[WARNING]** `posthog/hogql_queries/hog_flow_query_runner.py:compute_next_fire` — Failed to compute next fire time
    - properties: flow_id, recurrence, error
    - _Triggered when the recurrence spec is malformed or in the past._

### Error tracking
> Two new failure modes: cron parse errors and queue enqueue failures. Neither is currently captured.

- `posthog/hogql_queries/hog_flow_query_runner.py:compute_next_fire` — **workflows_schedule_parse_failed**
    ```
    posthoganalytics.capture_exception(exc, properties={"flow_id": flow.id, "recurrence": flow.schedule})
    ```
    - fingerprint: `workflows.schedule.parse`
    - _Without this, a malformed schedule will silently drop runs._

### Feature flags
> The new trigger type is a backend behavior change, not a UX swap. Bias here is **no flag needed** unless the team wants to gate the FE picker to dogfooders first. The previous `batch` trigger shipped without a flag, so absent a stated rollout concern we recommend skipping.

_(no flag suggested)_

### Slack follow-up
> Your PostHog project has Slack connected. I can drop a quick recap into a channel of your choice ~7 days after this PR merges, with how the new instrumentation is performing.

**Suggested channel:** `product-internal`

To opt in, reply to this comment with:

```
/prehog notify #product-internal 7d
```

<details><summary>Reviewers skipped</summary>

- **llm** — No LLM call sites were added in this PR.

</details>

<sub>PR: [#54115](https://github.com/PostHog/posthog/pull/54115) · model: `claude-opus-4-7` · this is an auto-generated review; reply with /prehog help for options.</sub>

<!-- prehog -->
