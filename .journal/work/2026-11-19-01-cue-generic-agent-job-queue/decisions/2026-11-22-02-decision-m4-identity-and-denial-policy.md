---
id: ent_01a2034b-a5d7-792a-93b2-97c7c5113d2e
workItemId: wi_01a1f564-641f-7c6c-972f-5757c4fb6fef
entryType: decision
title: "M4 identity and denial policy: open without clients, flag by default, prose refusals never block"
summary: "Signatures are required exactly when `clients` are configured; denials flag by default and block only by opt-in; Codex refusals seen only in prose add a flag but never count as denials; only mutations and rejections are audited."
createdBy: "45464946+AlexandruCalinica@users.noreply.github.com"
createdAt: "2026-11-22T12:46:59.275Z"
updatedAt: "2026-11-22T12:46:59.275Z"
source: manual
metadata:
  codeReferences:
    - path: packages/daemon/src/auth.ts
      relation: constrains
    - path: packages/core/src/config.ts
      relation: constrains
    - path: packages/harness/src/adapters/codex.ts
      relation: constrains
    - path: packages/daemon/src/actors/gateway.ts
      relation: mentions
links:
  - id: lnk_01a2034b-a5fa-77ba-a020-dce5f22e5e4b
    fromEntryId: ent_01a2034b-a5d7-792a-93b2-97c7c5113d2e
    toEntryId: ent_01a1f79f-d440-7e6b-94c2-491746c3037e
    relation: relates_to
    createdAt: "2026-11-22T12:46:59.275Z"
    targetPath: 2026-11-20-03-decision-cli-as-libeam-client-node.md
---

# Decision: M4 identity and denial policy

## Context

M4 adds Ed25519 client identity and a denial policy (plan entry 7). Four choices had
defaults that later work depends on: when signatures are mandatory, what a denial does by
default, how to treat Codex sandbox refusals, and what the audit log records. The CLI as a
libeam client node with app-level signing was decided earlier (linked decision).

## Options Considered

1. Auth: always required / a separate `auth.required` switch / required exactly when `clients` is non-empty.
2. Default `onDenial`: `block` / `flag`.
3. Codex refusals: match agent prose as denials / ignore them / structured denials only, prose as a soft flag.
4. Audit: every call / mutations plus every rejection.

## Decision

- Signatures are required exactly when `clients` is non-empty; with none the Gateway stays open and `cued` warns at boot.
- `safety.onDenial` defaults to `flag`; `block` (global or per pool) ends a denied job as terminal status `blocked`.
- Codex: a failed `command_execution` whose output shows a sandbox refusal is a denial; refusals only described in agent prose add the `possible-sandbox-refusal` flag and never block.
- Audit records submits, cancels and every rejected call (client, method, job, reason); successful reads and `ping` are not audited.

## Rationale

- One rule with no extra switch: listing a client is the opt-in, and existing single-user setups keep working.
- `flag` keeps M3 behaviour; blocking a job whose agent worked around a denial is a behaviour change operators should choose.
- Codex 0.171 logs no item for a refused command (recorded in `fixtures/codex/sandbox-refusal.jsonl`), so the only signal is text, which can false-positive ("no permission denied errors"). A flag keeps it visible without failing good jobs.
- Polling clients would flood an audit log of reads; mutations and rejections are what an investigation needs.

## Consequences

- A daemon with no clients is open to any cookie holder; the boot warning is the only guard.
- Codex jobs rarely reach `blocked` until Codex emits structured refusals; `possible-sandbox-refusal` is the signal to watch.
- `requester` stays self-asserted; routing and scope use the verified `client`.

## Validation / Evidence

`packages/daemon/test/auth.test.ts` (8 tests), `packages/cli/test/cli.auth.e2e.test.ts` (3),
and the replay test in `packages/daemon/test/cued.test.ts`, where the Claude and Codex denial
fixtures end `blocked` and the prose fixture is only flagged. `npm run check` passes 129/129.

## Follow-Up

- Revisit the `flag` default once operators have run with `block`.
- Re-record Codex fixtures when a newer CLI reports sandbox refusals as structured items.
