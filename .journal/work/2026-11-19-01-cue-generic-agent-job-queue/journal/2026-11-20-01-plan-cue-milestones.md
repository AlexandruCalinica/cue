---
id: ent_01a1f79f-d442-7f1d-905b-50e47b05e347
workItemId: wi_01a1f564-641f-7c6c-972f-5757c4fb6fef
entryType: plan
entryNumber: 1
title: "Plan: cue milestones M0 to M5"
summary: "Plans cue from the done M0 scaffold through single-node runtime (M1), migration shim (M2), routing and more harnesses (M3), identity and safety (M4) and multi-host (M5)."
createdBy: "45464946+AlexandruCalinica@users.noreply.github.com"
createdAt: "2026-11-20T06:23:29.341Z"
updatedAt: "2026-11-20T06:23:29.341Z"
source: manual
links:
  - id: lnk_01a1f79f-d448-71b7-ae68-c6a3677db15d
    fromEntryId: ent_01a1f79f-d442-7f1d-905b-50e47b05e347
    toEntryId: ent_01a1f79f-d43d-7afc-92c8-9727d172420d
    relation: references
    createdAt: "2026-11-20T06:23:29.341Z"
    targetPath: ../_research/2026-11-20-01-web-coding-agent-queue-market-survey.md
  - id: lnk_01a1f79f-d449-7dc3-a7d7-85237b040459
    fromEntryId: ent_01a1f79f-d442-7f1d-905b-50e47b05e347
    toEntryId: ent_01a1f79f-d43e-78f2-acaa-64e3681ceae1
    relation: references
    createdAt: "2026-11-20T06:23:29.341Z"
    targetPath: ../decisions/2026-11-20-01-decision-typescript-rewrite-on-libeam.md
  - id: lnk_01a1f79f-d44a-768c-ad7c-01e5e799500b
    fromEntryId: ent_01a1f79f-d442-7f1d-905b-50e47b05e347
    toEntryId: ent_01a1f79f-d43f-7c04-a099-4b84467d8352
    relation: references
    createdAt: "2026-11-20T06:23:29.341Z"
    targetPath: ../decisions/2026-11-20-02-decision-libeam-primitives-only.md
  - id: lnk_01a1f79f-d44b-75d4-8703-7214e585108c
    fromEntryId: ent_01a1f79f-d442-7f1d-905b-50e47b05e347
    toEntryId: ent_01a1f79f-d440-7e6b-94c2-491746c3037e
    relation: references
    createdAt: "2026-11-20T06:23:29.341Z"
    targetPath: ../decisions/2026-11-20-03-decision-cli-as-libeam-client-node.md
  - id: lnk_01a1f79f-d44c-7920-bb41-25f9870537d9
    fromEntryId: ent_01a1f79f-d442-7f1d-905b-50e47b05e347
    toEntryId: ent_01a1f79f-d441-780f-8752-b75922ac687e
    relation: references
    createdAt: "2026-11-20T06:23:29.341Z"
    targetPath: ../decisions/2026-11-20-04-decision-generic-core-script-hooks.md
---

# Entry 1: Plan - cue milestones M0 to M5

## Project Timeline

- Entry 1 (this): plan for M0 to M5. Supported by the market-survey research and four decisions (TypeScript on libeam, libeam stays primitives-only, CLI as a libeam client node, generic core with script-first hooks).

## Feature Overview

### Problem Statement

Teams running coding agents headless need a queue that accepts jobs from many clients, runs them on one or more hosts under resource limits, routes them across harnesses and accounts by rules and quotas, survives restarts, and reports honest outcomes. The motivating predecessor (an internal single-harness Claude Code queue) had no retries, no notifications, permission denials reported as success, no per-client identity and flat-file state.

### Goals

- Durable queue: SQLite source of truth, fenced leases, restart-safe.
- Multi-harness adapters (Claude Code first, then Codex and Cursor) normalised to one event model.
- Rule-based routing with per-account quotas and rate-limit pauses.
- A CLI that is a libeam client node; per-client identity later.
- Honest results: "blocked" and "denied" are distinct from "succeeded".
- No organisation-specific code; org behaviour goes in hooks.

### Non-Goals

- An interactive GUI/TUI for watching agents.
- Hosting the agents' models or proxying their APIs.
- Built-in PR, VCS or ticketing workflows (those are hooks).

## Current State Analysis

### Relevant Existing Code

The M0 scaffold (entry 2) defines the contracts: `packages/core/src/{job,config}.ts`, `packages/harness/src/harness.ts`, `packages/router/src/{router,quota}.ts`, `packages/store/src/index.ts`, `packages/daemon/src/{protocol,hooks,process,daemon}.ts`, `packages/cli/src/{commands,client,cue}.ts`.

### Patterns to Follow

Pure decision logic (routing, quota) stays in plain functions with unit tests. Actors own state and side effects. Zod schemas sit at system boundaries.

### Integration Points

libeam (actors, supervisors, clustering), `node:sqlite`, `systemd-run --scope` or process groups, harness CLIs, hook executables.

## Proposed Design

### Architecture

Supervision tree on `cued`: Store, Gateway (named `cue.gateway`), Router, QueueProducer (DB-backed), QuotaActor, per-pool DynamicSupervisor (`maxChildren`) running JobActor, which runs ProcessActor, plus a Notifier.

### Data Structures

`JobRecord`, `Lease` (holder, fencing token, expiry), append-only `StoredEvent` log; see `SQLITE_SCHEMA`.

### Key Algorithms / Logic

- Route: match rules, then the candidate pools that pass the quota check, then the least-loaded pool.
- On a rate limit: requeue without consuming an attempt and pause the account until reset.
- Lease renewal with heartbeat; stale holders are fenced out on write.

## Implementation Plan

- [x] **M0: scaffold and contracts.** Packages, types, Zod config schema, SQL schema, README design, ISC license, unit tests, CI file (parked). Checkpoint: lint, build and tests green (done, entry 2).
- [ ] **M1: single node.** SQLite store, Gateway, QueueProducer, pools, JobActor, ProcessActor (output tail to files, process-tree kill, systemd-scope and process-group isolation), script HookRunner, Claude adapter parsing from fixtures, `cue` client. Checkpoint: end-to-end tests with a fake harness: submit, run, cancel, timeout, daemon restart mid-job.
- [ ] **M2: migration shim for existing users.** Import or bridge jobs from a flat-file predecessor queue and provide compatibility hooks, so a single-harness setup can move over without changing its clients. Checkpoint: replay of recorded job specs through the shim in dry-run.
- [ ] **M3: routing and more harnesses.** Codex and Cursor adapters, rule-based routing across them, quotas, budgets, rate-limit pauses, notifications. Checkpoint: fixture-backed adapter tests; routing table tests.
- [ ] **M4: identity and safety.** Per-client Ed25519 keys signing gateway calls, per-client verbs, lanes and limits, audit events, and permission-denial detection that fails or flags jobs. Checkpoint: unsigned or wrong-key calls rejected; denial fixtures yield `blocked`.
- [ ] **M5: multiple hosts.** Runner nodes with libeam roles, store-backed leases and single-router election across nodes. Checkpoint: kill a runner mid-job, lease expires, job requeued exactly once.

## Testing Strategy

Vitest unit tests for pure logic; contract tests against the `Store` interface; fixture-driven adapter tests; a fake-harness binary for end-to-end runs; multi-node tests on localhost ports.

## Edge Cases and Error Handling

Daemon crash mid-job (orphaned process tree), clock skew on lease expiry, hook timeouts, harness output format drift, partial writes, quota resets during a run.

## Open Questions

- Should libeam get a light-client mode to cut CLI join latency?
- Where should a shared store live for M5 (SQLite on the router node vs. Postgres)?
- Exact semantics per hook point on failure.

## Next Steps

1. Start M1 with the SQLite store and its contract tests.
2. Then ProcessActor with process-group isolation (systemd scope needs a user session).
