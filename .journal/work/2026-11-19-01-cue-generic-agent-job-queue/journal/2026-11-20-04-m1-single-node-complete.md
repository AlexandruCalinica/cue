---
id: ent_01a1f9ab-c469-716c-ae49-cb10543012dd
workItemId: wi_01a1f564-641f-7c6c-972f-5757c4fb6fef
entryType: implementation
entryNumber: 4
title: "M1 single node complete: runtime, Claude parsing, CLI"
summary: "Completed M1 on branch m1-single-node: Claude stream-json parsing from recorded fixtures, the Gateway/Scheduler/JobActor runtime, the cue CLI as a libeam client node and a runnable cued. npm run check passes 72/72 and a real Claude Code job ran end to end."
createdBy: "45464946+AlexandruCalinica@users.noreply.github.com"
createdAt: "2026-11-20T15:55:46.317Z"
updatedAt: "2026-11-20T15:55:46.317Z"
source: manual
metadata:
  codeReferences:
    - path: packages/harness/src/adapters/claude.ts
      relation: changes
    - path: packages/daemon/src/actors/
      kind: directory
      relation: changes
    - path: packages/daemon/src/daemon.ts
      relation: changes
    - path: packages/daemon/src/protocol.ts
      relation: changes
    - path: packages/daemon/src/cued.ts
      relation: changes
    - path: packages/store/src/index.ts
      relation: changes
    - path: packages/cli/src/
      kind: directory
      relation: changes
    - path: README.md
      relation: changes
links:
  - id: lnk_01a1f9ab-c489-7c29-8614-827196ce3774
    fromEntryId: ent_01a1f9ab-c469-716c-ae49-cb10543012dd
    toEntryId: ent_01a1f9ab-c414-7f15-ad3d-94f0ece03c52
    relation: references
    createdAt: "2026-11-20T15:55:46.317Z"
    targetPath: ../decisions/2026-11-20-05-decision-m1-runtime-shape.md
  - id: lnk_01a1f9ab-c4bb-7012-a4c8-b063798b3e2b
    fromEntryId: ent_01a1f9ab-c469-716c-ae49-cb10543012dd
    toEntryId: ent_01a1f998-7fdc-7d07-9e7e-702ced6f4abb
    relation: references
    createdAt: "2026-11-20T15:55:46.317Z"
    targetPath: 2026-11-20-03-m1-store-process-hooks.md
  - id: lnk_01a1f9ab-c4de-7903-be19-08ef5b02f02f
    fromEntryId: ent_01a1f9ab-c469-716c-ae49-cb10543012dd
    toEntryId: ent_01a1f79f-d442-7f1d-905b-50e47b05e347
    relation: references
    createdAt: "2026-11-20T15:55:46.317Z"
    targetPath: 2026-11-20-01-plan-cue-milestones.md
  - id: lnk_01a1f9ab-c506-706e-b16d-eb229eb70a44
    fromEntryId: ent_01a1f9ab-c469-716c-ae49-cb10543012dd
    toEntryId: ent_01a1f79f-d440-7e6b-94c2-491746c3037e
    relation: references
    createdAt: "2026-11-20T15:55:46.317Z"
    targetPath: ../decisions/2026-11-20-03-decision-cli-as-libeam-client-node.md
---

# Entry 4: M1 single node complete

## Project Timeline

- Entry 1: plan for M0 to M5 (research plus four decisions).
- Entry 2: M0 scaffold and contracts landed; djournal installed and shared.
- Entry 3: M1 part 1: SQLite store, process controller, script hooks.
- Entry 4 (this): M1 done: Claude parsing, daemon runtime, CLI, runnable `cued`. Decision: runtime shape (Scheduler + JobActor).

## Current State

### Components Status

| Component | Status |
| --- | --- |
| `@cue/core`, `@cue/router` | working, tested |
| `@cue/store` | working, tested; schema v2 (runtime column, `activeLeases`) |
| `@cue/harness` Claude adapter | working; parses init, text, tool_use, `permission_denied`, rejected `rate_limit_event`, result |
| `@cue/daemon` Gateway / Scheduler / JobActor | working, e2e tested |
| `cued` binary | working (distributed, cookie required) |
| `@cue/cli` (`cue`) | working against real `cued` |
| Lanes, notifications, Codex/Cursor adapters | not started (M3) |
| CI | still parked at `docs/ci.yml` |

## Work Done This Session

### Claude adapter

Recorded two real runs (Claude Code 2.1.329, haiku): a plain reply and a Bash permission denial. Sanitized them into `packages/harness/test/fixtures/claude/` (init trimmed, no account/MCP data, paths replaced, thinking omitted), plus hand-written rate-limit and max-turns fixtures. The recording showed denials arrive as `system/permission_denied` and rate state as `rate_limit_event`, which the parser now maps.

### Daemon runtime

- Gateway (`cue.gateway`): validate, cap `maxMinutes`, route, insert, poke; `ping/submit/status/list/cancel/logs/events/stats`.
- Scheduler: reclaim expired leases, lease per pool within concurrency and rate quota, pause accounts on rate limits, adopt this node's leases at boot.
- JobActor: prepare → run → post → finalize from the stored phase; per-attempt state in the store; hooks off-mailbox; SIGTERM then SIGKILL on cancel/timeout; rate limits requeue without spending an attempt; `maxAttempts` enforced.
- See the runtime-shape decision for why this replaces QueueProducer/QuotaActor/DynamicSupervisor/ProcessActor.

### CLI and cued

`cue` joins the cluster (CUE_SEEDS, CUE_COOKIE), uses `gatewayClient()` from `@cue/daemon/protocol` (no daemon code loaded). `cued` loads `cue.yaml`, quiets libeam logs, and SIGTERM leaves harnesses running for re-attach.

### Problems found and fixed

- A later rate-limit signal without a reset time overwrote a known reset time, shortening the account pause to the 15-minute default (caught by the e2e test).
- Remote `getActorByName` refs are untyped `ActorRef`s, so `ref.call("submit", spec)` passed `spec` as the timeout; `gatewayClient` always sends `{ method, args }`.

## Validation

| Command | Result | Notes |
| --- | --- | --- |
| `npm run check` | pass | 72/72 tests, 10 files; repeated 3x without flakes |
| `npx vitest run packages/daemon` x5 | pass | 28/28 each, timing-sensitive e2e stable |
| Manual: `cued` + `cue` with real Claude Code (haiku) | pass | job succeeded, report `cue works`, cost about $0.0024 |

## Files Modified

| File | Changes |
| --- | --- |
| `packages/harness/src/adapters/claude.ts`, `test/fixtures/claude/*` | parser and fixtures |
| `packages/daemon/src/actors/{gateway,scheduler,job}.ts`, `runtime.ts`, `daemon.ts`, `protocol.ts`, `cued.ts` | runtime |
| `packages/daemon/test/cued.test.ts`, `test/fixtures/fake-harness.mjs` | 14 e2e tests and a stream-json fake harness |
| `packages/store/src/index.ts` | schema v2, `setRuntime`/`getRuntime`, `activeLeases` |
| `packages/cli/src/{client,run,cue,commands}.ts`, `test/cli.e2e.test.ts` | client node, commands, real-binary e2e |
| `README.md`, `cue.example.yaml` | M1 design, running instructions, unenforced keys marked |

## Open Questions / Blockers

- Rate-limit pauses are in Scheduler memory and lost on restart.
- `cue.example.yaml` still lists a `codex` pool; `cued` refuses to start with it until the M3 adapter exists.
- CI still needs moving to `.github/workflows/` by someone with the `workflow` scope.
- Untracked `.agents/package.json` and `.pi/` remain undecided.
- Branch `m1-single-node` is not pushed or merged.

## Next Steps

1. Review and merge `m1-single-node`.
2. M2: migration shim from the flat-file predecessor queue (dry-run replay checkpoint).
3. M3: Codex and Cursor adapters, lanes, notifications.

## Commits This Session

- `9214255` feat(store,daemon): SQLite store, process controller and script hook runner
- `19a5e37` chore(journal): record M1 part 1
- `eaf62ee` feat(harness): parse Claude Code stream-json output from fixtures
- `11c1d43` feat(daemon): single-node runtime on libeam
- `0aea48e` feat(cli,daemon): cue CLI as a libeam client node and a runnable cued
- `3c244ac` docs: describe the M1 runtime
