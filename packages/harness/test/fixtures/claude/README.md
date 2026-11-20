# Claude Code stream-json fixtures

- `ok.jsonl`, `deny.jsonl`: recorded from Claude Code 2.1.329 (`claude -p ... --output-format stream-json --verbose --model haiku`) on 2026-11-20, then sanitized: init trimmed to a few fields (no MCP/plugin/account data), usage and timing blocks dropped, local paths replaced with `/work`, thinking text omitted.
- `rate-limited.jsonl`, `error-max-turns.jsonl`: hand-written from the recorded shapes, since those outcomes can't be triggered on demand. Replace with recordings when one is captured.
