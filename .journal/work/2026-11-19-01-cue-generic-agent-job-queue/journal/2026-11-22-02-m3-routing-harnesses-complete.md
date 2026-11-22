---
id: ent_01a201f1-fa3e-7def-95e8-a783a1191423
workItemId: wi_01a1f564-641f-7c6c-972f-5757c4fb6fef
entryType: implementation
entryNumber: 6
title: "M3 done (minus Cursor): Codex adapter, preference routing, pauses, budgets, lanes, notifications"
summary: "Implemented M3 on branch m3-routing-harnesses except the deferred Cursor adapter: Codex adapter from recorded runs, preference routing with fallback, persisted rate-limit pauses (schema v3), per-pool spend budgets, lane caps and webhook/command notifications. npm run check passes 99/99 and a real Codex job ran through cued."
createdBy: "45464946+AlexandruCalinica@users.noreply.github.com"
createdAt: "2026-11-22T06:29:25.296Z"
updatedAt: "2026-11-22T06:29:25.296Z"
source: manual
metadata:
  codeReferences:
    - path: packages/harness/src/adapters/codex.ts
      relation: changes
    - path: packages/harness/src/harness.ts
      relation: changes
    - path: packages/store/src/index.ts
      relation: changes
    - path: packages/router/src/budget.ts
      relation: changes
    - path: packages/daemon/src/actors/scheduler.ts
      relation: changes
    - path: packages/daemon/src/actors/job.ts
      relation: changes
    - path: packages/daemon/src/notify.ts
      relation: changes
    - path: packages/daemon/src/daemon.ts
      relation: changes
    - path: packages/core/src/config.ts
      relation: changes
    - path: README.md
      relation: changes
    - path: cue.example.yaml
      relation: changes
links:
  - id: lnk_01a201f1-fa5e-7c00-8a60-0d3ac57fb260
    fromEntryId: ent_01a201f1-fa3e-7def-95e8-a783a1191423
    toEntryId: ent_01a201df-781e-70b3-87c5-ee625acfc96e
    relation: references
    createdAt: "2026-11-22T06:29:25.296Z"
    targetPath: 2026-11-22-01-plan-m3-routing-harnesses.md
  - id: lnk_01a201f1-fa7b-76a1-8098-c9d5372d19c8
    fromEntryId: ent_01a201f1-fa3e-7def-95e8-a783a1191423
    toEntryId: ent_01a201df-784c-77a7-9015-be7ae7f83421
    relation: references
    createdAt: "2026-11-22T06:29:25.296Z"
    targetPath: ../decisions/2026-11-22-01-decision-drop-m2-migration-shim.md
  - id: lnk_01a201f1-fa99-7ce6-aa91-b0dd4fb0c848
    fromEntryId: ent_01a201f1-fa3e-7def-95e8-a783a1191423
    toEntryId: ent_01a1f9ab-c414-7f15-ad3d-94f0ece03c52
    relation: references
    createdAt: "2026-11-22T06:29:25.296Z"
    targetPath: ../decisions/2026-11-20-05-decision-m1-runtime-shape.md
---

# Entry 6: M3 done (minus Cursor)

## Project Timeline

- Entry 1: plan for M0 to M5 (research plus four decisions).
- Entry 2: M0 scaffold and contracts.
- Entry 3: M1 part 1: SQLite store, process controller, script hooks.
- Entry 4: M1 done: Claude parsing, daemon runtime, CLI, `cued`. Merged as PR #1.
- Entry 5: plan for M3. Decision: drop M2.
- Entry 6 (this): M3 implemented except the Cursor adapter (deferred by the user).

## Current State

### Components Status

| Component | Status |
| --- | --- |
| Claude adapter | working (unchanged) |
| Codex adapter | working; fixture tests plus one real job through `cued` |
| Cursor adapter | not started; deferred by the user |
| Preference routing and fallback | working, e2e tested |
| Rate-limit pauses | persisted in `pool_state` (schema v3), survive restart |
| Spend budgets | working; Codex reports no cost so counts as $0 |
| Lanes | caps across pools and disabled lanes enforced |
| Notifications | webhook and command, best effort, at most once |
| CI | still parked at `docs/ci.yml` |

## Work Done This Session

### Codex adapter (phase 1)

Recorded three real `codex exec --json` runs (codex-cli 0.171.0): plain reply,
shell command under `read-only` sandbox, unsupported model. Hand-wrote a
usage-limit fixture. Verified on the CLI that exec options must precede
`resume <id>` and that `--` before the prompt works with and without resume.
Pool options: `sandbox` (default `workspace-write`), `bypassSandbox`, `config`.

### Routing, pauses, budgets, lanes (phases 3 to 5, one commit)

`leaseNext` takes `available` pools and `blockedLanes`; `isEligible` lets a
later candidate take a job only when no earlier candidate is available. The
Scheduler loops until no pool makes progress, so a pool filling up frees work
for pools visited earlier in the pass. `stats` adds `budgets` and `lanes`.

### Notifications (phase 6)

`notify.ts` runs after `finish`; webhooks POST `{event, result}` with headers,
timeout, one retry on 5xx/429/network error; commands reuse the hook runner with
`CUE_HOOK=notify`. `on` is validated: `terminal`, each terminal status, `flagged`.

## Key Implementation Details

- Contract changes: `result.text` is nullable (null means the last message is
  the report, persisted as `lastMessage` in the attempt); adapters may define
  `validateOptions`, called by `startCued` at boot.
- Phases 3 to 5 share the Scheduler availability check, so they landed as one
  commit rather than three.
- A Python string replace with an empty match corrupted `store/src/index.ts`
  once; restored from git and redone with guarded replacements. No commit was affected.

## Decisions

- M2 dropped (see decision entry, recorded with the plan).
- Defaults taken without asking (open questions in the plan): USD-only budgets;
  notifications on terminal outcomes only.

## Validation

| Command | Result | Notes |
| --- | --- | --- |
| `npm run check` | pass | 99/99 tests, 13 files (was 72 at M1) |
| Manual: `cued` with a codex pool + `cue submit` | pass | job succeeded, wrote the file, report `done` from last message |

## Files Modified

| File | Changes |
| --- | --- |
| `packages/harness/src/adapters/codex.ts`, `test/codex.test.ts`, `test/fixtures/codex/*` | new adapter, 8 tests, 4 fixtures |
| `packages/harness/src/harness.ts` | nullable result text, `validateOptions` |
| `packages/store/src/index.ts`, `test/store.test.ts` | v3, `LeaseQuery`, `isEligible`, `spendSince`, `activeLaneCounts`, pool pauses |
| `packages/router/src/budget.ts` | pure budget helpers |
| `packages/daemon/src/actors/scheduler.ts` | availability, preference loop, persisted pauses, stats |
| `packages/daemon/src/notify.ts`, `actors/job.ts`, `daemon.ts`, `runtime.ts`, `hooks.ts`, `cued.ts` | notifier, codex registration, option validation |
| `packages/daemon/test/routing.test.ts`, `notify.test.ts`, `fixtures/fake-harness.mjs` | 4 + 4 tests, `ratelimit-if` step |
| `packages/core/src/config.ts` | pool `budget`, notifier `headers`/`timeoutSec`, validated `on` |
| `README.md`, `cue.example.yaml` | M3 docs, adapter table, M2 dropped |

## Open Questions / Blockers

- Cursor adapter deferred; needs `cursor-agent` installed and logged in for real fixtures.
- `cue` CLI has no `stats` command; stats are only reachable through the Gateway call.
- Queued jobs blocked by pauses, budgets or lanes don't show the reason in `cue status`.
- Codex sandbox refusals are prose only, so they are not counted as denials (M4 concern).
- CI still needs moving to `.github/workflows/`.

## Next Steps

1. Review and merge `m3-routing-harnesses` (not pushed yet).
2. Optionally add `cue stats` and blocked-reason output.
3. Cursor adapter when the CLI is available; then M4 identity and safety.

## Commits This Session

- `b40f5e0` feat(harness): Codex adapter from recorded codex exec --json runs
- `a0976dd` feat(router,store,daemon): preference routing, persisted pauses, spend budgets, lanes
- `3c94e85` feat(daemon): webhook and command notifications on job outcomes
- `60731b8` docs: describe M3 routing, Codex adapter, budgets, lanes and notifications; mark M2 dropped
