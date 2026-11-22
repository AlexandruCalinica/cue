---
id: ent_01a201df-781e-70b3-87c5-ee625acfc96e
workItemId: wi_01a1f564-641f-7c6c-972f-5757c4fb6fef
entryType: plan
entryNumber: 5
title: "Plan: M3 routing, Codex and Cursor adapters, lanes, budgets, notifications"
summary: "Plans M3 on branch m3-routing-harnesses: Codex and Cursor adapters, preference-ordered routing with fallback, persisted rate-limit pauses, per-pool spend budgets, lane concurrency and notifications. M2 is dropped by decision."
createdBy: "45464946+AlexandruCalinica@users.noreply.github.com"
createdAt: "2026-11-22T06:09:12.489Z"
updatedAt: "2026-11-22T06:09:12.489Z"
source: manual
metadata:
  codeReferences:
    - path: packages/harness/src/adapters/
      kind: directory
      relation: mentions
    - path: packages/router/src/
      kind: directory
      relation: mentions
    - path: packages/daemon/src/actors/scheduler.ts
      relation: mentions
    - path: packages/daemon/src/actors/job.ts
      relation: mentions
    - path: packages/store/src/index.ts
      relation: mentions
    - path: packages/core/src/config.ts
      relation: mentions
links:
  - id: lnk_01a201df-78b6-7641-ba4d-3b2802a9e32d
    fromEntryId: ent_01a201df-781e-70b3-87c5-ee625acfc96e
    toEntryId: ent_01a1f79f-d442-7f1d-905b-50e47b05e347
    relation: references
    createdAt: "2026-11-22T06:09:12.489Z"
    targetPath: 2026-11-20-01-plan-cue-milestones.md
  - id: lnk_01a201df-78df-7049-ba2b-436a2279f49e
    fromEntryId: ent_01a201df-781e-70b3-87c5-ee625acfc96e
    toEntryId: ent_01a201df-784c-77a7-9015-be7ae7f83421
    relation: references
    createdAt: "2026-11-22T06:09:12.489Z"
    targetPath: ../decisions/2026-11-22-01-decision-drop-m2-migration-shim.md
  - id: lnk_01a201df-7902-7a18-a43e-451bbceb92a2
    fromEntryId: ent_01a201df-781e-70b3-87c5-ee625acfc96e
    toEntryId: ent_01a1f9ab-c414-7f15-ad3d-94f0ece03c52
    relation: references
    createdAt: "2026-11-22T06:09:12.489Z"
    targetPath: ../decisions/2026-11-20-05-decision-m1-runtime-shape.md
  - id: lnk_01a201df-b107-77cf-81c6-83f43287a366
    fromEntryId: ent_01a201df-781e-70b3-87c5-ee625acfc96e
    toEntryId: ent_01a1f79f-d441-780f-8752-b75922ac687e
    relation: references
    createdAt: "2026-11-22T06:09:12.489Z"
    targetPath: ../decisions/2026-11-20-04-decision-generic-core-script-hooks.md
  - id: lnk_01a201df-b126-7e76-8ed5-c9da4671be2f
    fromEntryId: ent_01a201df-781e-70b3-87c5-ee625acfc96e
    toEntryId: ent_01a1f9ab-c469-716c-ae49-cb10543012dd
    relation: references
    createdAt: "2026-11-22T06:09:12.489Z"
    targetPath: 2026-11-20-04-m1-single-node-complete.md
---

# Entry 5: Plan - M3 routing, harnesses, lanes, budgets, notifications

## Project Timeline

- Entry 1: plan for M0 to M5 (research plus four decisions).
- Entry 2: M0 scaffold and contracts.
- Entry 3: M1 part 1: SQLite store, process controller, script hooks.
- Entry 4: M1 done: Claude parsing, daemon runtime, CLI, `cued`. Merged as PR #1.
- Entry 5 (this): plan for M3. Decision: [drop M2](../decisions/2026-11-22-01-decision-drop-m2-migration-shim.md).

## Feature Overview

### Problem Statement

cue runs Claude Code only. `lanes` and `notify` are parsed but ignored, rate-limit
pauses live in Scheduler memory, and routing ignores the order of a rule's
`use` list once a job is queued: any candidate pool with room can take it.

### Goals

1. Codex and Cursor adapters behind the existing `HarnessAdapter` contract.
2. Routing honours preference order and falls back when earlier pools are full, paused, over budget or disabled.
3. Rate-limit pauses survive a daemon restart.
4. Per-pool spend budgets (USD per window) pause a pool when exceeded.
5. Lane concurrency caps across pools; disabled lanes hold their jobs.
6. Webhook and command notifications on job outcomes.

### Non-Goals

- M2 importer or predecessor compatibility (dropped).
- Client identity, per-client lanes, denial policy (M4); multiple hosts (M5).
- Token-based budgets; adapter auto-discovery or plugins loaded from outside cue.

## Current State Analysis

### Relevant Existing Code

- `packages/harness/src/harness.ts`: `HarnessAdapter` (`build`, `parseLine`) and normalised `HarnessEvent`s. Only `adapters/claude.ts` exists.
- `packages/router/src/router.ts`: pure `route()` returns ordered `candidates`; `quota.ts` holds `canStart`, `recordStart`, `recordRateLimit`.
- `packages/daemon/src/actors/scheduler.ts`: per tick, for each pool with room and quota, `store.leaseNext({ pool })`; pauses kept in a `quotas` Map.
- `packages/store/src/index.ts` `leaseNext` (about line 331): first queued job whose `candidates` JSON contains the pool, by priority then age. Preference position is ignored.
- `packages/daemon/src/actors/job.ts`: `finalize()` writes `result.json`, runs `onComplete` hooks, then `finish`.
- `packages/core/src/config.ts`: `lanes`, `notify` and `rate` schemas exist; no `budget`.

### Patterns to Follow

- Pure logic in `@cue/router` with unit tests; actors stay thin.
- Fixtures recorded from real CLIs, sanitised, under `packages/harness/test/fixtures/<id>/`.
- Side effects (hooks) run off the actor mailbox and report back with a cast.
- Store schema migrations bump the version (currently v2).

### Integration Points

Adapter registry in the daemon, `cued` boot validation of pool harness ids,
the Scheduler leasing loop, JobActor finalize, `cue stats` output.

## Proposed Design

### Architecture

No new actors. The Scheduler gains a per-tick availability view (room, pause,
budget, lane) and asks the store for the best job for each pool given that view.
Notification delivery is a daemon-side helper called from JobActor finalize,
off-mailbox like hooks.

### New Components

- `adapters/codex.ts`: `codex exec --json` with prompt, `-C workdir`, `--skip-git-repo-check`, model and sandbox from pool `options`; resume via `codex exec resume <id>`. Maps `thread.started` to session, agent messages to message, command or tool items to tool, `turn.completed` to result (cost null, tokens kept in event data), errors and `turn.failed` to failed result or rate_limit.
- `adapters/cursor.ts`: `cursor-agent -p --output-format stream-json`, model and `--force` from options; maps its system/assistant/tool_call/result events. Built from the documented format; fixtures hand-written until a real recording is possible.
- `@cue/router` `pick.ts`: pure eligibility (is pool P allowed to take job J, given J's candidates and the set of currently available pools; lane caps).
- `@cue/router` `budget.ts`: pure spend window check.
- `packages/daemon/src/notify.ts`: webhook POST (JSON result, timeout, one retry) and command (argv plus `result.json` path, no shell).

### Modified Components

- Store: schema v3 with `pool_state(pool, paused_until)`; `leaseNext` takes `available` pools and `fullLanes`; `spendSince(pool, since)` sums `costUsd` from finished results.
- Scheduler: load pauses at boot, persist on `rateLimited`; compute availability; count running per lane.
- Config: pool `budget: { usd, windowSec }`; notifier `on` values validated (`terminal`, each terminal status, `flagged`).
- JobActor: call notify after `finish`; failures become `notify-failed` events only.
- `cued`: register codex and cursor adapters; reject unknown harness ids at boot (already) and warn when a budget is set on a harness that reports no cost.
- README and `cue.example.yaml`: M2 dropped, new keys, harness notes.

### Data Structures

- `Availability = { pools: Set<string>; fullLanes: Set<string> }` built each tick.
- `pool_state` row: `pool TEXT PRIMARY KEY, paused_until INTEGER NULL`.

### Key Algorithms / Logic

Job J is eligible for pool P when P is in J.candidates, J's lane is not full or
disabled, and no candidate ordered before P is in `available.pools`. That keeps
work on the preferred pool while it has room and falls back only when it does
not. `leaseNext` fetches a bounded batch of queued jobs naming P, ordered by
priority and age, and returns the first eligible one.

## Implementation Plan

- [ ] **Phase 1: Codex adapter.** Record two or three real `codex exec --json` runs (plain reply, a shell command, a failure), sanitise, parse. Checkpoint: fixture tests pass; one manual Codex job through `cued`.
- [ ] **Phase 2: Cursor adapter.** Confirm the stream-json format from current docs; hand-written fixtures; mark them unverified in the fixture README. Checkpoint: fixture tests pass.
- [ ] **Phase 3: Preference routing and fallback.** `pick.ts`, store `leaseNext` with availability, Scheduler wiring. Checkpoint: routing table tests; e2e with two fake-harness pools showing fallback on full and paused pools.
- [ ] **Phase 4: Persisted pauses and budgets.** Schema v3, `pool_state`, `spendSince`, budget gating. Checkpoint: e2e restart keeps a pause; budget exceeded pauses a pool until the window moves.
- [ ] **Phase 5: Lanes.** Lane counts and disabled lanes. Checkpoint: e2e with a lane cap of 1 across two pools.
- [ ] **Phase 6: Notifications.** Webhook and command notifiers. Checkpoint: e2e against a local HTTP server and a script; a failing notifier leaves the job status unchanged.
- [ ] **Phase 7: Docs and close.** README, example config, `npm run check`, journal entry.

Each phase is one commit on `m3-routing-harnesses`.

## Testing Strategy

Fixture-driven adapter unit tests; pure tests for `pick`, `budget`, quota;
store contract tests for v3; daemon e2e with the existing fake harness extended
to emit Codex-style output when needed; `npm run check` green after each phase.

## Edge Cases and Error Handling

- Codex output drift between CLI versions: unknown lines become `unparsed` and flag the job, never crash.
- All candidates paused or over budget: job stays queued; `cue status` should say why.
- Job pinned to a disabled lane: stays queued until the lane is enabled.
- Budget window with no-cost harnesses: spend counts as 0; boot warning.
- Notifier hangs or 5xx: bounded timeout, one retry, event recorded.
- Pause persisted for a pool removed from config: ignored at boot.

## Open Questions

- Can `cursor-agent` be installed and logged in on this host to record real fixtures? Until then the adapter is unverified.
- Should Codex token usage feed a token budget later, or is USD-only enough?
- Should notifications also fire on `leased` or `rate-limited` events, or terminal only for M3?

## Next Steps

1. Approve this plan.
2. Start Phase 1 by recording Codex fixtures.
