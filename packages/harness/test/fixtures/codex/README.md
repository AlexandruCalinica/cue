# Codex fixtures

Recorded from `codex exec --json` (codex-cli 0.171.0, ChatGPT login) on 2026-11-22,
then sanitised: thread ids replaced with fixed UUIDs. No paths or account data appear
in these runs.

| File | Source |
| --- | --- |
| `ok.jsonl` | real: plain one-line reply |
| `tool.jsonl` | real: a shell command plus a write refused by the `read-only` sandbox (Codex reports the refusal only in prose) |
| `error-model.jsonl` | real: unsupported model, non-fatal `error` item then `turn.failed` |
| `sandbox-refusal.jsonl` | real: `touch` outside the workspace under `workspace-write`; Codex logs no command item, only prose |
| `command-denied.jsonl` | hand-written: a failed `command_execution` whose output shows a sandbox refusal (the shape cue treats as a denial) |
| `rate-limited.jsonl` | hand-written from the usage-limit wording Codex prints; not recorded |
