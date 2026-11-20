---
id: ent_01a1f79f-d43f-7c04-a099-4b84467d8352
workItemId: wi_01a1f564-641f-7c6c-972f-5757c4fb6fef
entryType: decision
title: "libeam stays primitives-only; app concerns live in cue"
summary: "Persistence, process control, rate limiting, durable leases and routing are cue application code built from libeam actors, not upstream libeam features."
createdBy: "45464946+AlexandruCalinica@users.noreply.github.com"
createdAt: "2026-11-20T06:23:29.341Z"
updatedAt: "2026-11-20T06:23:29.341Z"
source: manual
links:
  - id: lnk_01a1f79f-d445-77f5-8bb8-621dfb93c463
    fromEntryId: ent_01a1f79f-d43f-7c04-a099-4b84467d8352
    toEntryId: ent_01a1f79f-d43e-78f2-acaa-64e3681ceae1
    relation: references
    createdAt: "2026-11-20T06:23:29.341Z"
    targetPath: 2026-11-20-01-decision-typescript-rewrite-on-libeam.md
---

# Decision: libeam stays primitives-only; app concerns live in cue

## Context

Evaluating libeam for cue surfaced several missing capabilities: durable storage, spawning and killing OS processes from user actors, rate limiting, durable leases with a single router, and a way for remote clients to call actors.

## Options Considered

1. Add these features upstream in libeam.
2. Keep libeam a primitives library and build these features in cue as ordinary actors and modules.

## Decision

Option 2. libeam provides actors, supervision, GenStage, clustering and the registry. cue implements:

- persistence (SQLite store, source of truth);
- the process actor (spawn, stream output, kill the process tree, cgroup or process-group isolation);
- quotas and rate-limit pauses (pure functions in `@cue/router`, owned by a quota actor);
- durable, fenced leases and single-router election;
- the gateway the CLI calls.

## Rationale

Erlang/OTP and Elixir don't ship persistence or business-level rate limiting either; those belong to the application. Keeping libeam small keeps it reusable.

## Consequences

- libeam changes are limited to real bugs or missing primitives (for example, the pub-port assumption noted in the M0 entry).
- libeam has no exported API for user-level child processes, so cue owns process control.
- libeam's GenStage Producer only emits inside `handleDemand`, so cue uses its own DB-backed queue actor plus `DynamicSupervisor` with `maxChildren` for pools.

## Validation / Evidence

Reading the libeam source: `child_process` is only used to fork libeam's own nodes, and node health is in-memory only.

## Follow-Up

- Offer libeam a small fix for the pub-port assumption (not approved yet).
