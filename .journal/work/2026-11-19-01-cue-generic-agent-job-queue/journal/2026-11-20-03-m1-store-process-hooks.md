---
id: ent_01a1f998-7fdc-7d07-9e7e-702ced6f4abb
workItemId: wi_01a1f564-641f-7c6c-972f-5757c4fb6fef
entryType: implementation
entryNumber: 3
title: "M1 part 1: SQLite store, process controller and script hooks"
summary: "Implemented the node:sqlite Store with fenced leases and reusable contract tests, the process-group/systemd ProcessController with an output tailer, and the script HookRunner; lint, build and 46/46 tests pass. Uncommitted."
createdBy: "45464946+AlexandruCalinica@users.noreply.github.com"
createdAt: "2026-11-20T15:34:35.434Z"
updatedAt: "2026-11-20T15:34:35.434Z"
source: manual
metadata:
  codeReferences:
    - path: packages/store/src/index.ts
      relation: changes
    - path: packages/store/test/store.test.ts
      relation: changes
    - path: packages/core/src/job.ts
      relation: changes
    - path: packages/daemon/src/process.ts
      relation: changes
    - path: packages/daemon/src/hooks.ts
      relation: changes
    - path: packages/daemon/test/process.test.ts
      relation: changes
    - path: packages/daemon/test/hooks.test.ts
      relation: changes
links:
  - id: lnk_01a1f998-800e-7048-adc3-774c76a2a240
    fromEntryId: ent_01a1f998-7fdc-7d07-9e7e-702ced6f4abb
    toEntryId: ent_01a1f79f-d442-7f1d-905b-50e47b05e347
    relation: references
    createdAt: "2026-11-20T15:34:35.434Z"
    targetPath: 2026-11-20-01-plan-cue-milestones.md
  - id: lnk_01a1f998-803a-7141-85e6-75295340c77a
    fromEntryId: ent_01a1f998-7fdc-7d07-9e7e-702ced6f4abb
    toEntryId: ent_01a1f79f-d443-7a05-a2ae-337e9b5cb2c8
    relation: references
    createdAt: "2026-11-20T15:34:35.434Z"
    targetPath: 2026-11-20-02-m0-scaffold.md
  - id: lnk_01a1f998-8065-7f4e-be0d-96199d66b2d1
    fromEntryId: ent_01a1f998-7fdc-7d07-9e7e-702ced6f4abb
    toEntryId: ent_01a1f79f-d441-780f-8752-b75922ac687e
    relation: references
    createdAt: "2026-11-20T15:34:35.434Z"
    targetPath: ../decisions/2026-11-20-04-decision-generic-core-script-hooks.md
---

# Entry 3: M1 part 1 - store, process controller, script hooks

## Project Timeline

- Entry 1: plan for M0 to M5 (research plus four decisions).
- Entry 2: M0 scaffold and contracts landed; djournal installed and shared.
- Entry 3 (this): first M1 slice, the libeam-independent foundations: SQLite store, ProcessController, script HookRunner.

## Current State

### Components Status

| Component | Status |
| --- | --- |
| `@cue/core` | working, tested; `JobResult` is now a zod schema (`JobResultSchema`), plus `JobIdSchema` |
| `@cue/store` | working, tested: `openSqliteStore` implemented |
| `@cue/daemon` process layer | working, tested: `createProcessController`, `tailLines` |
| `@cue/daemon` hooks | working, tested: `createScriptHookRunner`, `PreRunOutputSchema` |
| `@cue/daemon` actors / `startCued` | not started (still `NotImplementedError`) |
| `@cue/harness` | partial: Claude `parseLine` still a stub |
| `@cue/cli` | parsing done; `connect` stub |

## Work Done This Session

### Store (`packages/store/src/index.ts`)

- `node:sqlite` store, WAL for file DBs, `busy_timeout`, `user_version` migration (v1); refuses DBs from a newer schema.
- `leaseNext` runs in `BEGIN IMMEDIATE`, picks lowest priority then oldest among jobs whose `candidates` JSON contains the pool, bumps `fence` and `attempt`.
- Every holder write (`renewLease`, `setPhase`, `finish`, `requeue`) is fenced on `id + fence + lease_owner + status in (leased, running)` and throws `StaleLeaseError` otherwise.
- Interface additions: `requeue({ lease, refundAttempt })` (rate limits/shutdown), `reclaimExpired(now)` (atomic requeue of expired leases, bumping fence; cancel-requested ones become `cancelled` with flag `lease-expired`), and `JobRecord.result`.
- `requestCancel` cancels queued jobs immediately with a synthesized result; flags leased/running ones.
- Rows are decoded with zod schemas because lint forbids type assertions.

### Process controller (`packages/daemon/src/process.ts`)

- Detached spawn in its own process group with stdio to files; status reads the exit-code file, then group liveness, then the file again (race-safe).
- Wrapper now writes the exit code atomically (`tmp` then `mv`).
- `kill(handle, signal = SIGTERM)` signals `-pgid`; with a scope unit and SIGKILL it also runs `systemctl --user stop`. Escalation is left to the caller (JobActor).
- `tailLines(path, offset)` returns complete lines only, exposes a resumable byte offset, and keeps multi-byte UTF-8 intact.

### Hook runner (`packages/daemon/src/hooks.ts`)

- Runs `hook.run` without a shell in its own process group, env = daemon env + `CUE_JOB_ID`, `CUE_HOOK`, `CUE_JOB_DIR`, `CUE_JOB_JSON`, `CUE_WORKDIR`, `CUE_RESULT_JSON` (when set).
- preRun stdout: empty means no changes; otherwise strict zod (`PreRunOutputSchema`, unknown keys rejected). Stdout capped at 1 MiB, stderr tail 4 KiB.
- Timeout: SIGTERM to the group, SIGKILL after a grace period, and settles without waiting for pipes to close.

## Key Implementation Details

- `LaunchSpec.env` is the complete harness environment; nothing is inherited, so JobActor must build it (PATH included).
- The `ProcessHandle` (pgid, unit) is not yet persisted in the store; reattach after restart needs it (store as an event or a column when JobActor lands).
- `node:sqlite` prints an ExperimentalWarning on Node 22; harmless.

## Decisions

No new standalone decisions. The hook runner follows the script-first hooks decision (linked).

## Validation

| Command | Result | Notes |
| --- | --- | --- |
| `npm run check` (lint, build, test) | pass | 8 test files, 46/46 tests (store 24, process 6, hooks 7, others 9) |
| `npx vitest run packages/daemon packages/store` x5 | pass | 38/38 each run; checked for flakiness of process timing tests |

## Files Modified

| File | Changes |
| --- | --- |
| `packages/store/src/index.ts` | SQLite store implementation, `StaleLeaseError`, new interface methods |
| `packages/store/test/store.test.ts` | reusable `storeContract` run on `:memory:` and file DBs, plus reopen/race/schema tests |
| `packages/core/src/job.ts` | `JobIdSchema`, `JobResultSchema` (type now inferred) |
| `packages/daemon/src/process.ts` | `createProcessController`, `tailLines`, atomic exit-code write |
| `packages/daemon/src/hooks.ts` | `createScriptHookRunner`, `PreRunOutputSchema`, `HookContext.resultPath` |
| `packages/daemon/test/{process,hooks}.test.ts` | new, real-process tests |
| `packages/{store,daemon}/package.json`, `package-lock.json` | add `zod`; local npm also dropped `libc` fields from optional binaries in the lockfile |

## Open Questions / Blockers

- CI still parked at `docs/ci.yml` (needs `workflow` scope).
- Where to persist `ProcessHandle` and the tail offset for restart reattach.
- Untracked `.agents/package.json` and `.pi/` (djournal pi-harness install artifacts) are still neither committed nor ignored.

## Next Steps

1. Claude adapter `parseLine` from recorded fixtures.
2. libeam actors: Gateway, QueueProducer, pools, JobActor (phase walk, hooks, lease renewal, cancel/timeout escalation), ProcessActor.
3. `startCued` and the `cue` client `connect`.
4. M1 checkpoint: fake-harness end-to-end tests (submit, run, cancel, timeout, daemon restart mid-job).

## Commits This Session

None; changes are uncommitted on `main`.
