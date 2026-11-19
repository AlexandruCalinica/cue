# cue

A generic job queue for coding agents. Clients submit jobs; `cued` routes each one to a
harness (Claude Code, Codex CLI, Cursor agent, ...) and account by rules, runs it headless in an
isolated process tree, and records every state change in SQLite. Built on
[libeam](https://github.com/AlexandruCalinica/libeam), an Erlang/OTP-style actor system for TypeScript.

> **Status: scaffold.** Packages, types, config schema and design are in place; the daemon,
> store and client are stubs (`NotImplementedError`). See [Milestones](#milestones).

cue is deliberately generic: it knows nothing about any company's repos, ticket system or
release flow. Anything org-specific plugs in through [hooks](#extension-model-hooks-and-plugins).

## Packages

| Package | What it holds |
|---|---|
| `@cue/core` | Job spec + id types, statuses and phases, the `cue.yaml` schema (zod) |
| `@cue/store` | `Store` port (jobs, fenced leases, write-ahead phases, events) and the SQLite schema |
| `@cue/harness` | `HarnessAdapter` interface, normalised `HarnessEvent`s, the Claude Code adapter |
| `@cue/router` | Pure routing (`route(spec, config)`) and quota/rate-limit state |
| `@cue/daemon` | `cued`: supervision tree, Gateway protocol, hook and process contracts |
| `@cue/cli` | `cue`: the client, itself a short-lived libeam node |

## Design

```
 cue (client node) ──libeam call──▶ Gateway ──▶ SQLite (source of truth)
                                       │ poke
                                       ▼
                                  QueueProducer ◀── QuotaActor (per account)
                                       │ lease (fenced)
                         ┌─────────────┼─────────────┐
                         ▼             ▼             ▼
                HarnessPool claude:a   codex:default  ...      (DynamicSupervisor, maxChildren = concurrency)
                         │
                      JobActor  prepare → run → post → finalize   (phase written before side effects)
                         │
                    ProcessActor  systemd-run --user --scope … (or process group); output → file, tailed
                         │
                      Notifier  webhooks / commands on job events
```

- **Gateway** (registered as `cue.gateway`) validates a submitted spec, asks the router for
  ordered candidate pools, writes the job and pokes the producer. It serves
  `submit / status / list / cancel / logs`.
- **Router** is a pure function over `cue.yaml` rules: the first rule whose `match`
  (labels, requester, lane) fits yields an ordered list of pools or harnesses; a job may pin
  `harness: claude` or `harness: claude:work`.
- **QueueProducer** owns demand: for each pool with free slots, lane room and quota, it takes
  the best queued job whose candidates include that pool (`leaseNext`) and starts a
  JobActor under the pool. Rate-limited jobs go back to the queue without using an attempt.
- **QuotaActor** (one per account) keeps a start budget (`rate: {jobs, windowSec}`) and pauses
  the account until the reset time a harness reports, or a default backoff.
- **JobActor** runs one attempt through `prepare` (preRun hooks), `run` (harness), `post`
  (postRun hooks) and `finalize` (result, onComplete hooks, notifications). Each phase is
  written to the store *before* its side effects, so a restarted actor resumes from the
  recorded phase instead of re-running finished work. It renews its lease while it runs.
- **ProcessActor** starts the harness through `systemd-run --user --scope` (cgroup memory/CPU/
  task limits, whole-tree kill via `systemctl --user stop`) or a plain process group. stdout and
  stderr go to files, never pipes, so a daemon restart doesn't kill the harness. The actor tails the
  file, turns lines into events through the adapter, and kills the tree on cancel or timeout.
- **Store** is SQLite (`node:sqlite`, WAL). Leases carry a monotonically increasing
  `fence`; every write by a lease holder presents it, and stale holders are rejected. At boot,
  expired or orphaned leases are re-leased and their JobActors respawned at their phase.
- **Notifier** sends events (terminal states, permission denials, empty results) to webhooks or
  commands. Denials are first-class: a run that "succeeded" with denials is flagged, not silent.

### Harness adapters

An adapter is pure: `build(input) → { argv, env }` and `parseLine(line) → HarnessEvent[]`.
The daemon owns processes, isolation, timeouts and kills, so every harness gets the same
guarantees. Events are normalised (`session`, `message`, `tool`, `denial`, `rate_limit`,
`result`, `unparsed`) so routing, quota and notifications don't depend on one vendor's format.

### Clients

`cue` is a libeam node. It joins the cluster through `CUE_SEEDS` with the shared `CUE_COOKIE`,
looks up `cue.gateway` and calls it. The libeam cookie only gates cluster membership, so **per-client
identity is planned for M4**: each client gets an Ed25519 key and signs requests (client, nonce,
timestamp, body hash); the Gateway checks them against an allow-list with per-client verbs and lanes.

## Extension model: hooks and plugins

cue's core never knows about your repositories, tickets or review flow. Organisations add that
through **hooks** declared in `cue.yaml` at three points: `preRun`, `postRun` and `onComplete`.
A hook is a plain executable run without a shell. It gets the job id, job directory, job spec
path, working directory and (after the run) the result path as `CUE_*` environment variables.
A `preRun` hook may print one JSON object to return a different `workdir` (e.g. a fresh git
worktree), extra `env`, `promptAppend` text, or a `resumeSession`. A failing required
`preRun` fails the job before any harness starts. A `postRun` hook is where you'd push a branch or open
a pull request, so the agent itself never needs those credentials. Jobs carry an opaque `meta`
object that cue stores and passes along but never reads, so hooks can carry their own data
(ticket keys, repo lists). In-process TypeScript plugins with the same three points are a
later option; scripts come first because they work with any language and any org.

## Configuration

See [`cue.example.yaml`](cue.example.yaml); the schema and its types live in
`packages/core/src/config.ts`.

## Development

```sh
npm install
npm run lint && npm run build && npm test
```

Node ≥ 22.13 (for `node:sqlite`).

## Milestones

- **M0 – scaffold** (this): packages, types, schema, design, CI.
- **M1 – single node**: SQLite store, Gateway, QueueProducer, pools, JobActor, ProcessActor,
  hook runner, Claude adapter parsing (fixture-backed), `cue` client; end-to-end tests with a fake harness.
- **M2 – more harnesses**: Codex and Cursor adapters; routing across them.
- **M3 – quota and notifications**: rate-limit handling, budgets, webhooks.
- **M4 – identity**: per-client Ed25519 keys, verbs and lanes per client.
- **M5 – multiple hosts**: runner nodes with libeam roles; store-backed leases across nodes.

## libeam notes

cue uses libeam as a primitives-only dependency. Things to know (as of libeam 0.3.0):

- `ZeroMQTransport` derives a peer's pub port as `rpcPort + 1`, so cue always uses the single
  `port` convention (rpc = p, pub = p+1, gossip = p+2) rather than custom `ports`.
- GenStage `Producer` emits only from `handleDemand`, so a database-backed queue can't push
  newly submitted jobs into pending demand. cue's QueueProducer therefore tracks demand itself
  and uses `DynamicSupervisor` (with `maxChildren`) for pools.
- `system.getActorByName()` returns an untyped `ActorRef`; call it as `ref.call({ method, args })`.

## License

ISC
