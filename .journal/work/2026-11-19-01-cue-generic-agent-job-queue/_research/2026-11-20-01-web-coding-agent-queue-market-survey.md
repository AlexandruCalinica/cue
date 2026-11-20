---
id: ent_01a1f79f-d43d-7afc-92c8-9727d172420d
workItemId: wi_01a1f564-641f-7c6c-972f-5757c4fb6fef
entryType: research
title: "Market survey: queues and orchestrators for coding-agent jobs"
summary: "No surveyed tool is a headless, rule-routed, multi-harness queue for shared hosts; interactive workspaces dominate and headless dispatchers are tiny. GitHub metadata and READMEs read 2026-11-18/20."
createdBy: "45464946+AlexandruCalinica@users.noreply.github.com"
createdAt: "2026-11-20T06:23:29.341Z"
updatedAt: "2026-11-20T06:23:29.341Z"
source: manual
---

# Web Research: Existing queues and orchestrators for coding-agent jobs

## Research Question

Is there an existing, ideally open-source, tool that runs coding-agent jobs (Claude Code, Codex CLI, Cursor agent, Gemini CLI, OpenCode, Aider, ...) as a **headless queue on a shared machine**, accepts submissions from other programs over the network or SSH, routes and load-balances across several harnesses and accounts by rules (labels, requester, quota, rate limits), and has good observability? If not, what can cue reuse or learn from?

## Summary

No surveyed project fits all of those needs. Popular tools are interactive GUIs/TUIs for a human supervising parallel agents. The few headless, quota-aware dispatchers (Argus, swrm, fleet) are very new, very small projects. Generic job queues are either heavy infrastructure (Temporal, Hatchet) or too thin (pueue, task-spooler). Metadata below was read from the GitHub REST API (first on 2026-11-18, re-checked 2026-11-20: stars, license, created and last push dates) and from each project's README.

## Motivating predecessor (lessons learned)

The starting point is an internal single-harness Claude Code job queue: a small daemon polls a directory of jobs, runs `claude -p` headless in cgroup-limited scopes, and a separate step publishes results. What it taught us:

- No retries and no backoff; a rate-limited or crashed run just fails.
- No notifications; clients poll for status.
- Permission denials inside the agent were recorded but the job still reported success, so "succeeded" could mean "did nothing".
- No per-client identity; every client shared one credential and the requester name was self-asserted.
- Flat-file state (one folder of JSON files per job) rescanned on every poll, with no transactions or leases.
- Hard-wired to one harness (command flags, output format, session resume, hook format).
- Worth keeping: per-job resource limits (cgroups), admission checks before starting work, and keeping publication (push, PRs) outside the agent process.

## Key Resources

| Resource | Type | URL | Relevance |
| --- | --- | --- | --- |
| Argus | OSS (Apache-2.0), ~2 stars, created 2026-10 | https://github.com/2Mundos/argus | Closest design: leased task queue, account failover on quota, MCP claiming, cost dashboard |
| swrm | OSS (Apache-2.0), ~6 stars | https://github.com/surlymochan/swrm | Lease-based dispatcher, routes by live quota, hard budgets, host-side verification |
| fleet | OSS (MIT), ~19 stars | https://github.com/sermakarevich/fleet | Small supervisor claiming tasks from a queue, per-task harness override |
| Agent Orchestrator | OSS (Apache-2.0), ~14.9k stars | https://github.com/OrchestratorInc/agent-orchestrator | Desktop app + local daemon, many harness adapters, CI/review feedback loop |
| Vibe Kanban | OSS (Apache-2.0), ~28.7k stars | https://github.com/BloopAI/vibe-kanban | Kanban UI over ~10 harnesses; README announces it is sunsetting |
| Claude Squad | OSS (AGPL-3.0), ~8.8k stars | https://github.com/smtg-ai/claude-squad | TUI over tmux + worktrees |
| ccmanager | OSS (MIT), ~1.3k stars | https://github.com/kbwo/ccmanager | TUI session manager for several CLIs |
| OpenHands | OSS (MIT), ~93.7k stars | https://github.com/OpenHands/OpenHands | Its own agent, not a multi-harness queue |
| open-swe | OSS (MIT), ~11.2k stars | https://github.com/langchain-ai/open-swe | Async cloud agent (its own harness) |
| claude-code-router | OSS (MIT), ~38.2k stars | https://github.com/musistudio/claude-code-router | Routes Claude Code across model providers |
| agentapi | OSS (MIT), ~1.5k stars | https://github.com/coder/agentapi | HTTP wrapper around several agent CLIs |
| Agent Client Protocol | Spec (Apache-2.0), ~4.7k stars | https://github.com/agentclientprotocol/agent-client-protocol | Standard editor-to-agent protocol; candidate adapter layer |
| Temporal | OSS (MIT), ~24.5k stars | https://github.com/temporalio/temporal | Durable workflows; heavy to operate |
| Hatchet | OSS (MIT), ~8.3k stars | https://github.com/hatchet-dev/hatchet | Task orchestration engine; needs its own server + DB |
| River | OSS (MPL-2.0), ~5.9k stars | https://github.com/riverqueue/river | Postgres/SQLite job queue for Go and others |
| BullMQ | OSS (MIT), ~9.6k stars | https://github.com/taskforcesh/bullmq | Redis/Postgres-backed Node queue |
| pueue | OSS (Apache-2.0), ~6.4k stars | https://github.com/Nukesor/pueue | Local shell-command queue daemon |
| task-spooler | OSS (GPL-2.0), ~450 stars, last push 2024 | https://github.com/justanhduc/task-spooler | Minimal local job spooler |

## Detailed Findings

### Interactive multi-agent workspaces

Agent Orchestrator, Vibe Kanban, Claude Squad and ccmanager all target a person watching agents. Agent Orchestrator's `ao` CLI is a thin client of a local daemon started by its desktop app ([docs/cli](https://github.com/OrchestratorInc/agent-orchestrator/blob/HEAD/docs/cli/README.md)). Vibe Kanban's MCP server is local-only and its web server has no authentication ([MCP docs](https://vibekanban.com/docs/integrations/vibe-kanban-mcp-server)). None offers rule-based routing across harness accounts.

### Headless dispatchers

Argus is the closest match: one process with SQLite, leased tasks with heartbeats, account failover on quota and an MCP surface for agents ([README](https://github.com/2Mundos/argus)). swrm routes by live quota with hard budgets and host-side verification ([README](https://github.com/surlymochan/swrm)). Both are weeks old with single-digit stars, so they're useful as references rather than as foundations.

### Harnesses and adapter layers

OpenHands and open-swe are agents, not queues. claude-code-router, agentapi and ACP could sit underneath cue's adapters, but they don't do queueing or routing between accounts.

### Generic queues

Temporal and Hatchet bring durable execution but need extra servers and databases, which is overkill for one or two hosts. pueue and task-spooler run local commands but have no leases, routing rules or network clients. BullMQ and River are libraries that still need everything above them.

## Best Practices

- Persist leases with heartbeats and fencing; never trust an in-memory "running" flag (Argus, swrm).
- Treat rate limits as a scheduling signal: requeue without consuming an attempt and pause the account until reset (Argus, swrm).
- Normalise each harness's output into one event model so routing and alerts stay harness-agnostic.

## Common Pitfalls

- Reporting success when the agent was blocked or did nothing.
- Unauthenticated local servers exposed beyond loopback (Vibe Kanban docs warn about this).
- GUI-first tools that assume a human attaches to every session.

## Official Documentation

- Vibe Kanban agent profiles: https://vibekanban.com/docs/configuration-customisation/agent-configurations
- Agent Orchestrator CLI: https://github.com/OrchestratorInc/agent-orchestrator/blob/HEAD/docs/cli/README.md

## Sources

All URLs in the Key Resources table, plus the two documentation links above. Star counts, licenses and push dates come from `https://api.github.com/repos/<owner>/<repo>` read on 2026-11-18 and re-checked 2026-11-20.

## Search Queries Used

- "open source job queue for coding agents Claude Code Codex headless scheduler load balancing 2026"
- "vibe kanban headless server remote executors Claude Code Codex Gemini Amp Cursor agent mcp 2026"
- GitHub API lookups for each repository listed above

## Open Questions

- Whether ACP adapters for Codex and Gemini are mature enough to replace native headless CLIs (not verified).
- How quickly Argus and swrm mature; revisit before M3.
