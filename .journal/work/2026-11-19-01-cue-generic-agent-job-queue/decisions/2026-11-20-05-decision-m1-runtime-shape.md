---
id: ent_01a1f9ab-c414-7f15-ad3d-94f0ece03c52
workItemId: wi_01a1f564-641f-7c6c-972f-5757c4fb6fef
entryType: decision
title: "M1 runtime: one Scheduler plus per-attempt JobActors, store as the coordinator"
summary: "cued runs a single Scheduler actor (queue polling, pool concurrency, rate quota, adoption) and one JobActor per attempt that owns its harness process, instead of the planned QueueProducer, QuotaActor, per-pool DynamicSupervisors and ProcessActor."
createdBy: "45464946+AlexandruCalinica@users.noreply.github.com"
createdAt: "2026-11-20T15:55:46.317Z"
updatedAt: "2026-11-20T15:55:46.317Z"
source: manual
metadata:
  codeReferences:
    - path: packages/daemon/src/actors/
      kind: directory
      relation: constrains
    - path: packages/daemon/src/daemon.ts
      relation: mentions
links:
  - id: lnk_01a1f9ab-c42f-7e4c-87f5-0421eac485ed
    fromEntryId: ent_01a1f9ab-c414-7f15-ad3d-94f0ece03c52
    toEntryId: ent_01a1f79f-d442-7f1d-905b-50e47b05e347
    relation: relates_to
    createdAt: "2026-11-20T15:55:46.317Z"
    targetPath: ../journal/2026-11-20-01-plan-cue-milestones.md
  - id: lnk_01a1f9ab-c44b-7b56-9a53-08da91598d35
    fromEntryId: ent_01a1f9ab-c414-7f15-ad3d-94f0ece03c52
    toEntryId: ent_01a1f79f-d43f-7c04-a099-4b84467d8352
    relation: references
    createdAt: "2026-11-20T15:55:46.317Z"
    targetPath: 2026-11-20-02-decision-libeam-primitives-only.md
---

# Decision: M1 runtime shape

## Context

The milestone plan's architecture had Gateway, a DB-backed QueueProducer, a QuotaActor per account, a DynamicSupervisor per pool (`maxChildren` = concurrency), JobActor, a separate ProcessActor and a Notifier. While building M1 on libeam 0.3.0 three facts mattered:

- Actor handlers run one at a time and are awaited, so any slow step blocks lease renewal unless it runs off the mailbox.
- GenStage producers can't push database rows into pending demand (already noted in the plan).
- The SQLite store already holds the authoritative lease, phase and per-attempt state, so actor-level supervision restarts add little.

## Options Considered

1. Follow the plan literally: QueueProducer + QuotaActor + DynamicSupervisor per pool + JobActor + ProcessActor.
2. One Scheduler actor that polls the store (tick and poke), enforces pool concurrency and per-account rate quota, and spawns/watches one JobActor per attempt; the JobActor drives its harness through a plain `ProcessController`.

## Decision

Option 2. The Scheduler is the parent of all JobActors with `maxRestarts: 0`: a crashed JobActor is not restarted in memory; its lease expires and `reclaimExpired` requeues the job (or, for this node's own live leases at boot, the Scheduler adopts them). Notifier and lane limits are deferred to M3.

## Rationale

- Concurrency counts and quota state live in one place, avoiding cross-actor races between a producer, a quota actor and a supervisor's `MaxChildrenError`.
- Recovery has one path (the store's lease and phase), whether the cause is an actor crash, a daemon restart or a dead node, which is what M5 needs anyway.
- A separate ProcessActor would only relay tail/status/kill calls; keeping process handling inside the JobActor keeps the phase machine and the process state in one persisted record.

## Consequences

- Scheduling is poll-based (`limits.tickMs`, default 500 ms) plus pokes from the Gateway and finished jobs.
- Per-account pauses live in Scheduler memory; a daemon restart forgets an active rate-limit pause (the job itself is safely requeued).
- M5 multi-host needs one scheduler per runner node with store-side leasing (already fenced), not a supervisor topology change.

## Validation / Evidence

`packages/daemon/test/cued.test.ts` covers concurrency, cancel, timeout, rate-limit requeue and pause, restart re-attach, exit-while-down and a foreign expired lease; `packages/cli/test/cli.e2e.test.ts` runs the real binaries. All pass (72/72 in `npm run check`).

## Follow-Up

- M3: lanes, notifications, and persisting rate-limit pauses if restarts during a pause prove to matter.
