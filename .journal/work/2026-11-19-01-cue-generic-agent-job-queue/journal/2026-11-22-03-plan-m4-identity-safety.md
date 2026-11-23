---
id: ent_01a2033a-012b-7927-859a-7cfe7066285d
workItemId: wi_01a1f564-641f-7c6c-972f-5757c4fb6fef
entryType: plan
entryNumber: 7
title: "Plan: queue visibility (cue stats, wait reasons) and M4 identity and safety"
summary: "Plans `cue stats` and wait reasons for queued jobs, then M4: Ed25519-signed gateway calls with per-client verbs, scope, lanes and limits, an audit log, and a denial policy that can end jobs as `blocked` (including Codex sandbox refusals)."
createdBy: "45464946+AlexandruCalinica@users.noreply.github.com"
createdAt: "2026-11-22T12:27:42.867Z"
updatedAt: "2026-11-22T12:27:42.867Z"
source: manual
metadata:
  codeReferences:
    - path: packages/daemon/src/actors/gateway.ts
      relation: changes
    - path: packages/daemon/src/protocol.ts
      relation: changes
    - path: packages/cli/src/
      kind: directory
      relation: changes
    - path: packages/core/src/config.ts
      relation: changes
    - path: packages/core/src/job.ts
      relation: changes
    - path: packages/store/src/index.ts
      relation: changes
    - path: packages/daemon/src/actors/job.ts
      relation: changes
    - path: packages/harness/src/adapters/codex.ts
      relation: changes
links:
  - id: lnk_01a2033a-0157-7255-a2f2-83d67fb14f9a
    fromEntryId: ent_01a2033a-012b-7927-859a-7cfe7066285d
    toEntryId: ent_01a1f79f-d440-7e6b-94c2-491746c3037e
    relation: references
    createdAt: "2026-11-22T12:27:42.867Z"
    targetPath: ../decisions/2026-11-20-03-decision-cli-as-libeam-client-node.md
  - id: lnk_01a2033a-0173-7b60-930e-d69150f4438b
    fromEntryId: ent_01a2033a-012b-7927-859a-7cfe7066285d
    toEntryId: ent_01a1f79f-d43d-7afc-92c8-9727d172420d
    relation: references
    createdAt: "2026-11-22T12:27:42.867Z"
    targetPath: ../_research/2026-11-20-01-web-coding-agent-queue-market-survey.md
---

# Entry 7: Plan - queue visibility and M4 identity and safety

## Project Timeline

- Entries 1-4: milestone plan, M0 scaffold, M1 single node (PR #1).
- Entry 5: M3 plan; M2 dropped (decision).
- Entry 6: M3 done except Cursor; merged as PR #2.
- Entry 7 (this): plan for `cue stats` and wait reasons, then M4. Cursor stays deferred.

## Feature Overview

### Problem Statement

Anyone holding `CUE_COOKIE` can call every Gateway verb and claim any `requester`
(`packages/core/src/job.ts` notes M4 replaces it). Operators can't see why a queued
job waits, and a job whose agent was denied permission still ends `succeeded` with
only a flag, the failure mode the market survey called out.

### Goals

1. `cue stats` and a wait reason on queued jobs in `cue status`.
2. Per-client Ed25519 keys; unsigned, wrong-key, stale or replayed calls rejected.
3. Per-client verbs, scope (own jobs vs all), allowed lanes, default lane, pool allow-list and limits.
4. Durable audit log of gateway calls, readable through `cue audit`.
5. Denial policy `flag | block`; `block` ends the job as new terminal status `blocked`.
6. Codex sandbox refusals counted as denials when they are visible in the output.

### Non-Goals

Encrypting the libeam transport, key rotation tooling, a client registry API
(clients live in `cue.yaml`), Cursor adapter, multi-host (M5).

## Current State Analysis

### Relevant Existing Code

- `daemon/src/protocol.ts`: `gatewayClient` sends `{ method, args }`; methods ping, submit, status, list, cancel, logs, events, stats.
- `daemon/src/actors/gateway.ts`: validates with zod, `GatewayError` for client errors; no caller identity.
- `cli/src/client.ts`, `commands.ts`, `run.ts`: CLI as a libeam node, pure argv parsing, `Io` for tests.
- `daemon/src/actors/scheduler.ts`: `available()` and `blockedLanes()` already compute why pools can't start work; `stats` call exists, CLI has no command.
- `daemon/src/actors/job.ts`: `buildResult` adds `permission-denied` flag; `decide()` picks the status.
- `store/src/index.ts`: schema v3, `SCHEMA_VERSION`, `pool_state` added by migration.

### Patterns to Follow

Pure helpers with unit tests (router style), zod config with defaults, store contract
tests, fake-harness e2e in `daemon/test`, fixtures for adapters.

### Integration Points

Config (`clients`, `safety`, rule `match.client`), store (schema v4), gateway wire
format, CLI env (`CUE_CLIENT`, `CUE_KEY_FILE`), terminal statuses (notify `on`, CLI output).

## Proposed Design

### Architecture

Signed request per call: `{ auth: { v: 1, client, ts, nonce, sig } | null, args }`. The
signature covers `cue/1\n<client>\n<ts>\n<nonce>\n<method>\n<sha256(canonical JSON of args)>`.
The Gateway authenticates and authorises before any handler logic, then writes an audit row.

### New Components

- `core/src/auth.ts`: canonical JSON, signing string, `signRequest`, `verifyRequest`, key encode/decode (Ed25519 raw public key as base64url, private key as PKCS8 PEM). Node `crypto` only.
- `daemon/src/auth.ts`: `authorize(config, method, request, now)` returning a `Caller` or a reason; nonce check through the store.
- CLI: `cue keygen [--out FILE]`, `cue stats`, `cue audit [-n N]`.

### Modified Components

- Config: `clients: { <name>: { publicKey, verbs, scope: own|all, lanes?, defaultLane?, pools?, maxActive?, maxMinutes? } }`, `auth.clockSkewSec` (60), `safety.onDenial: flag|block` (default `flag`), pool-level `onDenial` override, rule `match.client`.
- Auth is required exactly when `clients` is non-empty; with no clients the gateway stays open as today and `cued` warns at boot.
- Store v4: `jobs.client` column, `nonces(client, nonce, expires)`, `audit(seq, at, client, method, ok, reason, job_id)`; `countActiveByClient`, `checkNonce`, `appendAudit`, `readAudit`.
- Gateway: scope checks for status/list/logs/events/cancel; submit applies lane rules, pool allow-list on candidates, `maxMinutes` cap, `maxActive`; status adds `waiting` for queued jobs via a scheduler `waitReasons` call.
- `TERMINAL_STATUSES` gains `blocked`; `decide()` returns it when policy is `block` and denials > 0 on an otherwise successful or failed run (cancel/timeout keep priority).
- Codex adapter: completed `command_execution` with non-zero exit and output matching sandbox refusals (`Read-only file system`, `Operation not permitted`, `sandbox`) emits `denial`.

### Data Structures

`Caller { client: string | null, verbs, scope, ... }` (`null` client = open mode).
`WaitReason { pool, reason: "full" | "paused" | "over-budget" | "disabled" | "rate" | "lane-full" | "lane-disabled" | "preferred-elsewhere", until? }`.

### Key Algorithms / Logic

Verification order: shape, known client, |now - ts| <= skew, signature, method in verbs,
nonce unused (insert with expiry ts + 2*skew; prune expired on insert). Failures throw
`GatewayError("unauthorized: <reason>")` and are audited. Canonical JSON sorts object keys
recursively so both sides hash the same bytes regardless of key order.

## Implementation Plan

- [ ] Phase 1: scheduler `waitReasons`, gateway `status` adds `waiting`, CLI `cue stats` and wait output. Checkpoint: routing e2e shows reasons for full, paused and lane-capped pools.
- [ ] Phase 2: `core/src/auth.ts` with unit tests (sign/verify, tamper, key order). Checkpoint: tests green.
- [ ] Phase 3: config + store v4 + gateway authn/authz + audit + CLI signing and `keygen`/`audit`. Checkpoint: e2e rejects unsigned, wrong key, stale ts, replay, missing verb; scope hides other clients' jobs.
- [ ] Phase 4: denial policy and `blocked` status; Codex refusal detection from a new recorded fixture. Checkpoint: Claude `deny.jsonl` and the Codex fixture yield `blocked` under `block`, flag only under `flag`.
- [ ] Phase 5: README, `cue.example.yaml`, journal close. Checkpoint: `npm run check` green; manual signed `cue submit` against `cued`.

## Testing Strategy

Unit tests for auth helpers and wait reasons; store contract tests for nonces, audit and
client counts; gateway e2e in local mode with signed calls; CLI e2e over libeam with a key
file; adapter fixture tests; fake-harness denial run through the daemon.

## Edge Cases and Error Handling

Clock skew (configurable window), replay after restart (nonces persisted), duplicate key
across clients (boot error), unknown client in `match.client`, spec `lane` outside a client's
lanes (reject at submit), `requester` stays a free-form label while `client` is authoritative,
upgrading a v3 database (add column, existing jobs get `client = NULL`).

## Open Questions

- Default `onDenial`: `flag` keeps M3 behaviour; switch to `block` later if operators agree.
- Should `ping` stay unsigned for health checks? Planned: yes, not audited.

## Next Steps

1. Phase 1, then phases 2-5 in order on branch `m4-identity-safety`.
