---
id: ent_01a2034b-a61d-7d70-909b-8a3170d45994
workItemId: wi_01a1f564-641f-7c6c-972f-5757c4fb6fef
entryType: implementation
entryNumber: 8
title: "M4 done: signed client calls, per-client permissions, audit, blocked status; cue stats and wait reasons"
summary: "Implemented plan entry 7 on branch m4-identity-safety: `cue stats` and wait reasons, Ed25519-signed Gateway calls with per-client verbs, scope, lanes and limits, an audit log (schema v4), and a flag/block denial policy with a new `blocked` status. npm run check passes 129/129 and a signed real Codex job ran through cued."
createdBy: "45464946+AlexandruCalinica@users.noreply.github.com"
createdAt: "2026-11-22T12:46:59.275Z"
updatedAt: "2026-11-22T12:46:59.275Z"
source: manual
metadata:
  codeReferences:
    - path: packages/core/src/auth.ts
      relation: changes
    - path: packages/core/src/config.ts
      relation: changes
    - path: packages/core/src/job.ts
      relation: changes
    - path: packages/store/src/index.ts
      relation: changes
    - path: packages/router/src/router.ts
      relation: changes
    - path: packages/daemon/src/auth.ts
      relation: changes
    - path: packages/daemon/src/actors/gateway.ts
      relation: changes
    - path: packages/daemon/src/actors/scheduler.ts
      relation: changes
    - path: packages/daemon/src/actors/job.ts
      relation: changes
    - path: packages/daemon/src/protocol.ts
      relation: changes
    - path: packages/harness/src/adapters/codex.ts
      relation: changes
    - path: packages/cli/src/
      kind: directory
      relation: changes
    - path: README.md
      relation: changes
    - path: cue.example.yaml
      relation: changes
links:
  - id: lnk_01a2034b-a649-7afa-8823-dfc16539ec39
    fromEntryId: ent_01a2034b-a61d-7d70-909b-8a3170d45994
    toEntryId: ent_01a2033a-012b-7927-859a-7cfe7066285d
    relation: references
    createdAt: "2026-11-22T12:46:59.275Z"
    targetPath: 2026-11-22-03-plan-m4-identity-safety.md
  - id: lnk_01a2034b-a665-776b-bf92-b4db1ebd3510
    fromEntryId: ent_01a2034b-a61d-7d70-909b-8a3170d45994
    toEntryId: ent_01a2034b-a5d7-792a-93b2-97c7c5113d2e
    relation: references
    createdAt: "2026-11-22T12:46:59.275Z"
    targetPath: ../decisions/2026-11-22-02-decision-m4-identity-and-denial-policy.md
  - id: lnk_01a2034b-a691-79bc-8a7a-4bd69381b33e
    fromEntryId: ent_01a2034b-a61d-7d70-909b-8a3170d45994
    toEntryId: ent_01a1f9ab-c414-7f15-ad3d-94f0ece03c52
    relation: references
    createdAt: "2026-11-22T12:46:59.275Z"
    targetPath: ../decisions/2026-11-20-05-decision-m1-runtime-shape.md
---

# Entry 8: M4 done, plus queue visibility

## Project Timeline

- Entries 1-4: milestone plan, M0 scaffold, M1 single node (PR #1).
- Entry 5: M3 plan; M2 dropped (decision).
- Entry 6: M3 done except Cursor; merged as PR #2.
- Entry 7: plan for `cue stats`, wait reasons and M4. Cursor deferred again by the user.
- Entry 8 (this): all five plan phases implemented on `m4-identity-safety`.

## Current State

### Components Status

| Component | Status |
| --- | --- |
| `cue stats`, wait reasons on queued jobs | working, e2e tested |
| Signed Gateway calls (Ed25519, nonce, clock skew) | working; unit, gateway e2e and CLI e2e tests |
| Per-client verbs, scope, lanes, pools, maxActive, maxMinutes | working, e2e tested |
| Audit log + `cue audit` | working (store schema v4) |
| Denial policy, `blocked` status | working; recorded Claude and Codex fixtures replay as `blocked` |
| Codex refusal detection | structured denials from failed commands; prose-only refusals flagged |
| Cursor adapter | deferred |
| CI | still parked at `docs/ci.yml` |

## Work Done This Session

### Phase 1: queue visibility

Scheduler `blocker()` now drives both scheduling and a `waitReasons` call (pool disabled,
full, paused, rate, over budget; lane full or disabled; "other jobs ahead"). Gateway
`status` adds `waiting` for queued jobs. CLI: `cue stats` tables and wait lines in `cue status`.

### Phases 2-3: identity, permissions, audit

`core/src/auth.ts`: canonical JSON, signing string, sign/verify, key encoding, `createSigner`.
`daemon/src/auth.ts`: authenticator (shape, known client, skew, signature, verb, nonce).
Gateway rewritten around `serve()`: every call except `ping` takes `{ auth, args }`; scope
hides other clients' jobs as "no such job". Store v4: `jobs.client`, `nonces`, `audit`.
Router: `match.client` and a client pool allow-list. CLI: `keygen` (0600, no overwrite),
`audit`, signing from `CUE_CLIENT` + `CUE_KEY_FILE`.

### Phase 4: denial policy

`safety.onDenial` and pool `onDenial`; `decide()` returns `blocked` naming the denied tools
(cancel and timeout keep priority). New `flag` harness event. A real Codex 0.171 run showed
sandbox refusals produce no command item, only prose, so prose adds `possible-sandbox-refusal`.

### Phase 5: docs and manual run

README (status, Gateway, Router, Clients, results, adapters, Running, Milestones) and
`cue.example.yaml` (clients, auth, safety, `match.client`). `cue status` shows the client.

## Key Implementation Details

- Wire format changed: requests are `{ method, args: [{ auth, args }] }`. Old clients get
  "malformed request (is the cue client older than the daemon?)".
- `GatewayClient` is now an explicit interface; the Gateway uses a typed `ActorRefFrom<typeof Scheduler>`.
- Fixed a latent scheduler bug: a JobActor spawn failure during shutdown left a lease to
  expire; now the job is requeued and the pass stops. A first version looped forever because
  the failed spawn still counted as progress; caught by a hung test and fixed before commit.
- CLI e2e daemon setup moved to `packages/cli/test/support.ts`.

## Decisions

- Recorded as a decision entry: auth required exactly when `clients` exist; `flag` default;
  prose refusals only flag; audit mutations and rejections only.

## Validation

| Command | Result | Notes |
| --- | --- | --- |
| `npm run check` | pass | 129/129 tests, 16 files (was 99 at M3) |
| Manual: `cued` with a codex pool and one client | pass | unsigned submit rejected; signed job succeeded and wrote its file; `stats`, `audit` rendered |
| Manual: `codex exec` with sandboxed writes | observed | no `command_execution` item for refused commands; saved as fixture |

## Files Modified

| File | Changes |
| --- | --- |
| `packages/core/src/auth.ts`, `test/auth.test.ts` | new signing module, 4 tests |
| `packages/core/src/config.ts`, `job.ts` | clients, auth, safety, pool `onDenial`, `match.client`; `blocked` status |
| `packages/store/src/index.ts`, `test/store.test.ts` | v4 migration, client/nonce/audit methods, 4 tests |
| `packages/router/src/router.ts`, `quota.ts` | client matching and allow-list; `startBlocker` |
| `packages/daemon/src/auth.ts`, `actors/gateway.ts`, `protocol.ts`, `daemon.ts`, `types.ts`, `cued.ts` | authn/authz, audit, signed wire, `gatewayAs`, open-mode warning |
| `packages/daemon/src/actors/scheduler.ts`, `job.ts` | wait reasons, spawn-failure requeue; flag events, `blocked` |
| `packages/harness/src/adapters/codex.ts`, `harness.ts`, fixtures | refusal detection, `flag` event, 2 fixtures |
| `packages/daemon/test/auth.test.ts`, `cued.test.ts`, `routing.test.ts` | 8 auth tests, policy + replay tests, wait reasons |
| `packages/cli/src/*`, `test/*` | stats, audit, keygen, signing; shared e2e support, 3 signed e2e tests |
| `README.md`, `cue.example.yaml` | M4 docs |

## Open Questions / Blockers

- `flag` vs `block` default to revisit after operators try `block`.
- No key rotation tooling beyond editing `cue.yaml` and restarting `cued`.
- CI still needs moving to `.github/workflows/`.

## Next Steps

1. Review, push and open a PR for `m4-identity-safety`.
2. Cursor adapter when `cursor-agent` is available; then M5 (multiple hosts).

## Commits This Session

- `e66f146` feat(cli,daemon): cue stats and wait reasons for queued jobs
- `eb50fef` feat(core,store,daemon,cli): Ed25519 client identity, verbs, scope, limits and audit
- `5b6f125` feat(core,harness,daemon): denial policy with a blocked status; Codex refusal detection
- `75cf571` docs: describe client identity, audit, denial policy and wait reasons; show the client in cue status
