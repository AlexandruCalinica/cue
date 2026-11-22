# cue

A generic job queue for coding agents. Clients submit jobs; `cued` routes each one to a
harness (Claude Code, Codex CLI, Cursor agent, ...) and account by rules, runs it headless in an
isolated process tree, and records every state change in SQLite. Built on
[libeam](https://github.com/AlexandruCalinica/libeam), an Erlang/OTP-style actor system for TypeScript.

> **Status: M3 (routing and harnesses) done.** `cued` runs Claude Code and Codex CLI jobs on one
> host: SQLite store with fenced leases, hooks, cancel/timeout, preference routing with fallback,
> rate-limit pauses that survive restarts, spend budgets, lane caps, webhook/command
> notifications, restart re-attach, and the `cue` client over libeam. The Cursor adapter, client
> identity (M4) and multiple hosts (M5) come later; see [Milestones](#milestones).

cue is deliberately generic: it knows nothing about any company's repos, ticket system or
release flow. Anything org-specific plugs in through [hooks](#extension-model-hooks-and-plugins).

## Packages

| Package | What it holds |
|---|---|
| `@cue/core` | Job spec + id types, statuses and phases, the `cue.yaml` schema (zod) |
| `@cue/store` | `Store` port (jobs, fenced leases, write-ahead phases, events) and its SQLite implementation |
| `@cue/harness` | `HarnessAdapter` interface, normalised `HarnessEvent`s, the Claude Code and Codex CLI adapters |
| `@cue/router` | Pure routing (`route(spec, config)`), quota/rate-limit state and spend budgets |
| `@cue/daemon` | `cued`: Gateway, Scheduler and JobActors, process controller, script hook runner, notifier; `@cue/daemon/protocol` for clients |
| `@cue/cli` | `cue`: the client, itself a short-lived libeam node |

## Design

```
 cue (client node) ──libeam call──▶ Gateway ──▶ SQLite (source of truth: jobs, leases, phases, events)
                                       │ poke                 ▲
                                       ▼                      │ fenced writes
                                   Scheduler ── leaseNext per pool (preference, concurrency, quota, pause, budget, lanes)
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
  are fenced out), then works out which pools are *available*: enabled, with a free slot, inside
  their start quota (`rate: {jobs, windowSec}`), not paused by a rate limit and under their spend
  budget (`budget: {usd, windowSec}`, summed from finished jobs' `costUsd`). Each available pool
  takes the best queued job (`leaseNext`: lowest priority, then oldest) that lists it as a
  candidate, **is not preferred elsewhere** (no earlier candidate in the job's list is available)
  and whose lane is not disabled or at its cap. So work stays on a rule's first pool while it has
  room and falls back down the list only when it doesn't. Rate-limit pauses use the reset time a
  harness reports (or a 15-minute default) and are stored, so they survive a restart. At boot it
  adopts the leases this node (`node.id`) still holds and restarts their JobActors. The Gateway's
  `stats` call reports running jobs, pauses, budget spend and lane usage.
- **JobActor** runs one attempt through `prepare` (job dir, `job.json`, preRun hooks), `run`
  (harness), `post` (postRun hooks) and `finalize` (`result.json`, onComplete hooks, finish).
  Each phase is written to the store *before* its side effects and per-attempt state (process
  handle, output offset, parsed outcome) is kept in the store, so a restarted actor resumes
  instead of redoing work. Hooks run off the actor's mailbox, so it keeps renewing its lease and
  noticing cancel requests while they run. Cancel and timeout send SIGTERM to the process group,
  then SIGKILL after a grace period. A rate-limited run goes back to the queue without using an
  attempt (and may then run on a fallback pool); after `maxAttempts` a job fails. Once a job is
  finished, matching `notify` entries fire.
- **Notifications** (`notify` in `cue.yaml`) fire on `terminal`, a specific status, or `flagged`
  results. A webhook gets `POST {event: "job.finished", result}` with optional headers, a timeout
  and one retry on 5xx/429/network errors; a command runs like a hook with `CUE_HOOK=notify` and
  `CUE_RESULT_JSON`. Delivery is best effort and at most once, after the job is recorded, so a
  failing notifier only adds a `notify-failed` event and never changes the job's outcome.
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

An adapter is pure: `build(input) → { argv, env }` and `parseLine(line) → HarnessEvent[]`,
plus an optional `validateOptions(pool.options)` that `cued` runs at boot. The daemon owns
processes, isolation, timeouts and kills, so every harness gets the same guarantees. Events are
normalised (`session`, `message`, `tool`, `denial`, `rate_limit`, `result`, `unparsed`) so
routing, quota and notifications don't depend on one vendor's format. A `result` without text
means "the last message is the report".

| Adapter | Command | Pool `options` | Notes |
|---|---|---|---|
| `claude` | `claude -p … --output-format stream-json --verbose` | none | cost, turns, permission denials and rate-limit resets reported |
| `codex` | `codex exec --json --skip-git-repo-check -C <workdir> --sandbox … -- <prompt>` | `sandbox` (`workspace-write` default, `read-only`, `danger-full-access`), `bypassSandbox`, `config` (`-c` overrides) | no cost reported, so budgets count Codex jobs as $0; sandbox refusals appear only in prose, not as denials; usage limits parsed from "try again in …" |

Fixtures under `packages/harness/test/fixtures/<adapter>/` are recorded from real runs and
sanitised; their READMEs list which ones are hand-written.

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
`packages/core/src/config.ts`. `cued` refuses to start with a pool whose harness has no adapter
(`claude` and `codex` ship today) or whose `options` the adapter rejects. Jobs in a lane that is
not configured have no lane cap.

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
- **M2 – migration shim** (dropped): users switch over to cue clean; no importer or
  predecessor compatibility hooks.
- **M3 – routing and more harnesses** (done): Codex adapter (fixture-backed), preference routing
  with fallback, persisted rate-limit pauses, spend budgets, lane caps, webhook/command
  notifications. The Cursor adapter is deferred.
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
