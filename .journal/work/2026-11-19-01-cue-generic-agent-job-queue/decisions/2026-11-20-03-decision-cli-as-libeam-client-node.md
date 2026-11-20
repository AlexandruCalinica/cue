---
id: ent_01a1f79f-d440-7e6b-94c2-491746c3037e
workItemId: wi_01a1f564-641f-7c6c-972f-5757c4fb6fef
entryType: decision
title: "The cue CLI is a libeam client node"
summary: "The CLI joins the libeam cluster and calls the cue.gateway actor directly, with app-level Ed25519 identity planned on top of the shared cookie."
createdBy: "45464946+AlexandruCalinica@users.noreply.github.com"
createdAt: "2026-11-20T06:23:29.341Z"
updatedAt: "2026-11-20T06:23:29.341Z"
source: manual
links:
  - id: lnk_01a1f79f-d446-773f-afdb-c6f2cc666f2b
    fromEntryId: ent_01a1f79f-d440-7e6b-94c2-491746c3037e
    toEntryId: ent_01a1f79f-d43e-78f2-acaa-64e3681ceae1
    relation: references
    createdAt: "2026-11-20T06:23:29.341Z"
    targetPath: 2026-11-20-01-decision-typescript-rewrite-on-libeam.md
---

# Decision: The cue CLI is a libeam client node

## Context

Clients (people, bots, scripts) must submit and inspect jobs on a remote cue daemon. The predecessor did this over plain SSH with a shared credential and self-asserted requester names.

## Options Considered

1. An HTTP or Unix-socket RPC gateway in the daemon, with a thin CLI.
2. The CLI starts a short-lived libeam node, joins the cluster and calls the `cue.gateway` actor directly.

## Decision

Option 2. `cue` (the CLI) is a libeam node that joins the cluster and talks to named actors. An app-level identity layer (per-client Ed25519 keys signing requests) sits on top, because libeam's shared cookie only controls who can join the cluster.

## Rationale

- One transport and one programming model on both sides.
- The same path works over SSH tunnels, a tailnet or a LAN.
- Long-lived clients (bots) can stay connected and receive events.

## Consequences

- There is no client-only mode: a client binds three ports (rpc, pub = rpc+1, gossip = rpc+2) and joins gossip as a full member.
- Join latency of about 0.65 to 3 s per one-off CLI call; may be reduced by tuning gossip or a future libeam light-client mode.
- Untyped refs need `ref.call({ method, args })`; cue wraps this in a typed client (`GatewayCalls`).

## Validation / Evidence

A probe client joined a test cluster, resolved a named actor and made calls (about 0.09 ms per call once connected).

## Follow-Up

- M4: Ed25519 identity, per-client permissions and audit.
