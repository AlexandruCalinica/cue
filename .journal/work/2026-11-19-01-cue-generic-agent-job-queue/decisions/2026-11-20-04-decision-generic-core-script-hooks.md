---
id: ent_01a1f79f-d441-780f-8752-b75922ac687e
workItemId: wi_01a1f564-641f-7c6c-972f-5757c4fb6fef
entryType: decision
title: "Generic core; org behaviour through script-first hooks"
summary: "cue ships no organisation-specific logic; org workflows attach via executable lifecycle hooks configured in cue.yaml, with in-process plugins deferred."
createdBy: "45464946+AlexandruCalinica@users.noreply.github.com"
createdAt: "2026-11-20T06:23:29.341Z"
updatedAt: "2026-11-20T06:23:29.341Z"
source: manual
links:
  - id: lnk_01a1f79f-d447-7a4b-9e07-3ce7db38b708
    fromEntryId: ent_01a1f79f-d441-780f-8752-b75922ac687e
    toEntryId: ent_01a1f79f-d43d-7afc-92c8-9727d172420d
    relation: references
    createdAt: "2026-11-20T06:23:29.341Z"
    targetPath: ../_research/2026-11-20-01-web-coding-agent-queue-market-survey.md
---

# Decision: Generic core; org behaviour through script-first hooks

## Context

The predecessor wired one organisation's workflow into the queue: per-job working copies, dependency caches, PR threads, pushing and opening PRs, a tool-guard hook and journaling. cue is public and must work for any project or organisation.

## Options Considered

1. Ship those behaviours as built-in features with config switches.
2. Keep the core generic and expose lifecycle hooks; start with external scripts and add in-process TypeScript plugins later if needed.
3. Plugins only, from day one.

## Decision

Option 2. cue's core knows only jobs, pools, lanes, routing, quotas, processes and events. Organisation behaviour attaches at hook points (`preRun`, `postRun`, `onComplete` in the scaffold) listed in `cue.yaml`. A hook is any executable that gets the job context as JSON on stdin and returns JSON on stdout (for example, a `preRun` hook can supply a working directory and extra env). In-process plugins are a later option.

## Rationale

- Scripts are language-neutral and easy to audit, and an org can reuse its existing tooling.
- Keeps public code free of any organisation's details.
- Plugins add API-stability obligations; delay them until the hook contract has settled.

## Consequences

- Hook failures need clear semantics (abort, retry or ignore per hook point) and timeouts.
- Spawning a process per hook costs a little latency per job, which is acceptable at agent-job timescales.

## Validation / Evidence

The M0 scaffold defines `HookPoint`, `HookContext`, `PreRunOutput` and `HookRunner` in `packages/daemon/src/hooks.ts`, and `cue.example.yaml` shows hook configuration with no organisation-specific code.

## Follow-Up

- M1: implement `HookRunner` for scripts, with contract tests.
- M2: the migration shim for existing users is written as hooks, not core code.
