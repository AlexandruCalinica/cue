---
id: ent_01a1f79f-d43e-78f2-acaa-64e3681ceae1
workItemId: wi_01a1f564-641f-7c6c-972f-5757c4fb6fef
entryType: decision
title: "Build cue from scratch in TypeScript on libeam"
summary: "cue is a fresh TypeScript monorepo on libeam with no predecessor code reused, chosen over extending the Python predecessor or adopting a workflow engine."
createdBy: "45464946+AlexandruCalinica@users.noreply.github.com"
createdAt: "2026-11-20T06:23:29.341Z"
updatedAt: "2026-11-20T06:23:29.341Z"
source: manual
links:
  - id: lnk_01a1f79f-d444-7339-8dc8-e5922d342510
    fromEntryId: ent_01a1f79f-d43e-78f2-acaa-64e3681ceae1
    toEntryId: ent_01a1f79f-d43d-7afc-92c8-9727d172420d
    relation: references
    createdAt: "2026-11-20T06:23:29.341Z"
    targetPath: ../_research/2026-11-20-01-web-coding-agent-queue-market-survey.md
---

# Decision: Build cue from scratch in TypeScript on libeam

## Context

The predecessor (an internal single-harness Claude Code job queue, written in Python) proved the idea but can't be extended to several harnesses, accounts or hosts without a redesign. The market survey found nothing suitable to adopt. The maintainer of cue also maintains [libeam](https://github.com/AlexandruCalinica/libeam), a TypeScript actor system modelled on Erlang/OTP (supervisors, DynamicSupervisor, GenStage, bounded mailboxes, gossip clustering, ZeroMQ transport, distributed registry).

## Options Considered

1. Extend the Python predecessor in place.
2. Rewrite in TypeScript and call the old Python steps as subprocesses, porting later.
3. Rewrite in TypeScript from scratch on libeam, reusing no predecessor code.
4. Build on a generic workflow engine (Temporal, Hatchet) or queue library (BullMQ, River).

## Decision

Option 3: a TypeScript monorepo built on libeam, written from scratch.

## Rationale

- The owner prefers TypeScript, and libeam's maturity isn't a blocker because the same person owns it and can change it.
- Supervision trees, bounded mailboxes and demand-driven stages map directly onto "jobs as supervised processes, pools as bounded consumers".
- libeam clustering gives a path to several hosts without adding a broker.
- Workflow engines bring servers and databases that are too heavy for one or two hosts (see the research entry).

## Consequences

- Everything is rebuilt, including the parts of the predecessor that worked (cgroup limits, admission checks).
- cue moves with libeam's API; libeam bugs found along the way get fixed upstream.
- Node >= 22.13 for the built-in `node:sqlite`.

## Validation / Evidence

- libeam test suite run locally during evaluation: 535 of 536 passed; the one failure looked like a timing flake.
- A client-node probe joined a 2-node libeam cluster and called a named actor (join plus lookup about 3 s by default, about 0.65 s with a 100 ms gossip interval).

## Follow-Up

- Track the libeam limitations listed in the M0 implementation entry.
