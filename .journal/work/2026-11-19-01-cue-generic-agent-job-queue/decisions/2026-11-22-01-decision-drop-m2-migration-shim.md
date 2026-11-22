---
id: ent_01a201df-784c-77a7-9015-be7ae7f83421
workItemId: wi_01a1f564-641f-7c6c-972f-5757c4fb6fef
entryType: decision
title: "Drop M2: switch to cue clean, no migration shim"
summary: "M2 (importing or bridging jobs from the flat-file predecessor queue) is dropped; users switch to cue clean with no job import or compatibility hooks, and work moves straight to M3."
createdBy: "45464946+AlexandruCalinica@users.noreply.github.com"
createdAt: "2026-11-22T06:09:12.489Z"
updatedAt: "2026-11-22T06:09:12.489Z"
source: manual
links:
  - id: lnk_01a201df-7867-74af-ab9e-5428f942d06c
    fromEntryId: ent_01a201df-784c-77a7-9015-be7ae7f83421
    toEntryId: ent_01a1f79f-d442-7f1d-905b-50e47b05e347
    relation: references
    createdAt: "2026-11-22T06:09:12.489Z"
    targetPath: ../journal/2026-11-20-01-plan-cue-milestones.md
  - id: lnk_01a201df-788f-78bf-8342-99d9db2f9a89
    fromEntryId: ent_01a201df-784c-77a7-9015-be7ae7f83421
    toEntryId: ent_01a1f79f-d43e-78f2-acaa-64e3681ceae1
    relation: references
    createdAt: "2026-11-22T06:09:12.489Z"
    targetPath: 2026-11-20-01-decision-typescript-rewrite-on-libeam.md
---

# Decision: Drop M2, switch to cue clean

## Context

The milestone plan (entry 1) scheduled M2 as a migration shim: import or bridge
jobs from the flat-file predecessor queue and add compatibility hooks, so a
single-harness setup could move over without changing its clients. M1 merged
(PR #1) on 2026-11-22.

## Options Considered

1. Build the M2 shim as planned (job import plus compatibility hooks, dry-run replay checkpoint).
2. Skip M2 and switch over clean: drain or abandon the old queue, point clients at `cue`.

## Decision

Option 2. The user chose to skip importing the old job format and switch over
clean. M2 is dropped; the next milestone is M3.

## Rationale

- The user owns the only deployment that would migrate and accepts a clean cut-over.
- It is consistent with the rewrite decision (no predecessor code reused): no
  predecessor formats leak into the generic core.
- It removes a milestone whose value was a one-off transition.

## Consequences

- No importer, bridge, or predecessor-format compatibility hooks in cue.
- Old in-flight jobs must be drained or resubmitted by hand before cut-over.
- Milestone numbering keeps M3, M4, M5 as planned; M2 is marked dropped.

## Validation / Evidence

User instruction in session on 2026-11-22: "we can skip importing old job
format. we'll switch over clean."

## Follow-Up

- Mark M2 dropped in the README milestone list during M3.
