# cue

A generic job queue for coding agents. Clients submit jobs; `cued` routes each one to a
harness (Claude Code, Codex CLI, Cursor agent, ...) and account by rules, runs it headless in an
isolated process tree, and records every state change in SQLite. Built on
[libeam](https://github.com/AlexandruCalinica/libeam), an Erlang/OTP-style actor system for TypeScript.

> **Status: M1 (single node) done.** `cued` runs Claude Code jobs end to end on one host: SQLite
> store with fenced leases, hooks, cancel/timeout, rate-limit requeue, restart re-attach, and the
> `cue` client over libeam. Lanes, notifications and further harnesses are later milestones; see
> [Milestones](#milestones).

cue is deliberately generic: it knows nothing about any company's repos, ticket system or
release flow. Anything org-specific plugs in through [hooks](#extension-model-hooks-and-plugins).

## Packages

| Package | What it holds |
|---|---|
| `@cue/core` | Job spec + id types, statuses and phases, the `cue.yaml` schema (zod) |
| `@cue/store` | `Store` port (jobs, fenced leases, write-ahead phases, events) and its SQLite implementation |
| `@cue/harness` | `HarnessAdapter` interface, normalised `HarnessEvent`s, the Claude Code adapter |
| `@cue/router` | Pure routing (`route(spec, config)`) and quota/rate-limit state |
| `@cue/daemon` | `cued`: Gateway, Scheduler and JobActors, process controller, script hook runner; `@cue/daemon/protocol` for clients |
| `@cue/cli` | `cue`: the client, itself a short-lived libeam node |

## Design

```
 cue (client node) ──libeam call──▶ Gateway ──▶ SQLite (source of truth: jobs, leases, phases, events)
                                       │ poke                 ▲
                                       ▼                      │ fenced writes
                                   Scheduler ── leaseNext per pool (concurrency + rate quota)
                                       │ spawn + watch
                                       ▼
                                   JobActor   prepare → run → post → finalize   (phase written before side effects)
                                       │
                          ProcessController   systemd-run --user --scope … or a process group;
                                              stdout → file, tailed through the harness adapter
```

- **Gateway** (registered as `cue.gateway`) validates a submitted spec, caps `maxMinutes`, asks
  the router for ordered candidate pools, writes the job and pokes the scheduler. It serves
  `ping / submit / status / list / cancel / logs / events / stats`.
- **Router** is a pure function over `cue.yaml` rules: the first rule whose `match`
  (labels, requester, lane) fits yields an ordered list of pools or harnesses; a job may pin
  `harness: claude` or `harness: claude:work`.
- **Scheduler** runs on every tick and every poke. It reclaims expired leases (their old holders
  are fenced out), then for each pool with free slots and quota takes the best queued job whose
  candidates include that pool (`leaseNext`: lowest priority, then oldest) and starts a JobActor
  for it. It keeps each account's start budget (`rate: {jobs, windowSec}`) and pauses the account
  until the reset time a harness reports (or a 15-minute default). At boot it adopts the leases
  this node (`node.id`) still holds and restarts their JobActors.
- **JobActor** runs one attempt through `prepare` (job dir, `job.json`, preRun hooks), `run`
  (harness), `post` (postRun hooks) and `finalize` (`result.json`, onComplete hooks, finish).
  Each phase is written to the store *before* its side effects and per-attempt state (process
  handle, output offset, parsed outcome) is kept in the store, so a restarted actor resumes
  instead of redoing work. Hooks run off the actor's mailbox, so it keeps renewing its lease and
  noticing cancel requests while they run. Cancel and timeout send SIGTERM to the process group,
  then SIGKILL after a grace period. A rate-limited run goes back to the queue without using an
  attempt; after `maxAttempts` a job fails.
- **ProcessController** starts the harness through `systemd-run --user --scope` (cgroup
  memory/CPU/task limits, whole-tree kill via `systemctl --user stop`) or a plain process group.
  stdout and stderr go to files, never pipes, and the exit code is written atomically, so
  stopping `cued` doesn't stop running harnesses and a restarted `cued` re-attaches to them.
- **Store** is SQLite (`node:sqlite`, WAL, versioned schema). Leases carry a monotonically
  increasing `fence`; every write by a lease holder presents it, and stale holders get
  `StaleLeaseError`. The `Store` interface has contract tests any other backend must pass.
- **Results are honest**: a run that "succeeded" with permission denials is flagged
  `permission-denied`, a harness that exits without a result line fails, and unparseable output
  is flagged rather than ignored.

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
`packages/core/src/config.ts`. Not yet acted on in M1: `lanes` and `notify` (M3), and pools for
harnesses without an adapter (only `claude` ships today; `cued` refuses to start with others).

## Running

```sh
npm install && npm run build
export CUE_COOKIE="$(openssl rand -hex 24)"      # shared by cued and every client
node packages/daemon/dist/cued.js cue.yaml        # prints the CUE_SEEDS value to use

export CUE_SEEDS=127.0.0.1:47102                  # daemon node.port + 2 (gossip)
echo '{"prompt": "Fix the flaky test in src/foo.test.ts", "workdir": "/srv/repo"}' \
  | node packages/cli/dist/cue.js submit           # prints the job id
node packages/cli/dist/cue.js status <id>
node packages/cli/dist/cue.js logs <id> -n 50
node packages/cli/dist/cue.js cancel <id>
```

Each job gets `<dataDir>/jobs/<id>/` with `job.json`, the harness `stdout`/`stderr`, `exit-code`
and `result.json`. Without a `workdir` (from the spec or a preRun hook) the harness runs in that
job directory. Stopping `cued` (SIGTERM) leaves running harnesses alone; start it again with the
same `node.id` and `dataDir` and it picks them up.

## Development

```sh
npm install
npm run lint && npm run build && npm test
```

Node ≥ 22.13 (for `node:sqlite`).

CI: the workflow lives at [`docs/ci.yml`](docs/ci.yml) for now; move it to
`.github/workflows/ci.yml` to enable it (pushing workflow files needs a token with the `workflow` scope).

journal: this repo uses [djournal](https://www.npmjs.com/package/djournal) (`.agents/`, `AGENTS.md`). Its
machine-local files (`.djournal.json`, `.journal/`, `.claude/settings.json`) are gitignored; recreate them with
`journal install --target . --harness claude-code,codex,grok-bot --yes`.

## Milestones

- **M0 – scaffold** (done): packages, types, schema, design, CI.
- **M1 – single node** (done): SQLite store, Gateway, Scheduler, JobActor, process controller,
  hook runner, Claude adapter parsing (fixture-backed), `cue` client; end-to-end tests with a fake
  harness and with the real `cued`/`cue` binaries.
- **M2 – migration shim**: bridge or import jobs from an existing flat-file, single-harness queue,
  with compatibility hooks, so existing users can move over without changing clients.
- **M3 – routing and more harnesses**: Codex and Cursor adapters, rule-based routing across them,
  quotas, budgets, rate-limit pauses, notifications.
- **M4 – identity and safety**: per-client Ed25519 keys, verbs and lanes per client, audit events,
  permission-denial detection.
- **M5 – multiple hosts**: runner nodes with libeam roles; store-backed leases across nodes.

## libeam notes

cue uses libeam as a primitives-only dependency. Things to know (as of libeam 0.3.0):

- `ZeroMQTransport` derives a peer's pub port as `rpcPort + 1`, so cue always uses the single
  `port` convention (rpc = p, pub = p+1, gossip = p+2) rather than custom `ports`.
- GenStage `Producer` emits only from `handleDemand`, so a database-backed queue can't push
  newly submitted jobs into pending demand. cue's Scheduler therefore polls the store on ticks and
  pokes and enforces pool concurrency itself.
- `system.getActorByName()` returns an untyped `ActorRef` even with `ActorRegistry` augmentation;
  `ref.call("submit", spec)` would treat `spec` as the timeout. Use `gatewayClient(ref)` from
  `@cue/daemon/protocol`, which always sends `{ method, args }`.
- Actor handlers run one at a time and are awaited, so slow work (hooks) runs off the mailbox and
  reports back with a cast.

## License

ISC
