import { z } from "zod";
import type { HarnessAdapter, HarnessEvent } from "../harness.js";

/** Pool `options` understood by the Codex adapter. */
export const CodexOptionsSchema = z
  .object({
    /** `codex exec --sandbox`. Headless jobs usually need to edit files, hence `workspace-write`. */
    sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
    /**
     * Pass `--dangerously-bypass-approvals-and-sandbox`. Only for hosts that isolate
     * the process some other way (e.g. `isolation: systemd-scope` in a VM).
     */
    bypassSandbox: z.boolean().default(false),
    /** `-c key=value` overrides, value parsed as TOML by Codex. */
    config: z.record(z.string().min(1), z.string()).default({}),
  })
  .strict();

export type CodexOptions = z.infer<typeof CodexOptionsSchema>;

const ThreadStartedSchema = z.object({ type: z.literal("thread.started"), thread_id: z.string() });

const ItemSchema = z.looseObject({ id: z.string().optional(), type: z.string() });
const ItemCompletedSchema = z.object({ type: z.literal("item.completed"), item: ItemSchema });

const AgentMessageSchema = z.object({ type: z.literal("agent_message"), text: z.string() });
const McpToolCallSchema = z.looseObject({ type: z.literal("mcp_tool_call"), server: z.string().optional(), tool: z.string().optional() });

const ErrorSchema = z.object({ type: z.literal("error"), message: z.string() });
const TurnFailedSchema = z.object({ type: z.literal("turn.failed"), error: z.looseObject({ message: z.string() }) });
const TurnCompletedSchema = z.object({ type: z.literal("turn.completed") });

/** Item types that are tool use, mapped to a stable tool name. */
const TOOL_ITEMS: Readonly<Record<string, string>> = {
  command_execution: "shell",
  file_change: "file_change",
  web_search: "web_search",
};

/** Event and item types that carry nothing cue needs. */
const IGNORED_TYPES = new Set(["turn.started", "item.started", "item.updated"]);
const IGNORED_ITEMS = new Set(["reasoning", "todo_list", "error"]);

const LIMIT_RE = /(usage limit|rate limit|too many requests|\b429\b)/i;
const RETRY_IN_RE = /try again in ((?:\d+\s*(?:days?|hours?|minutes?|mins?|seconds?|secs?)[\s,]*(?:and\s+)?)+)/i;
const UNIT_MS: Readonly<Record<string, number>> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };

/** `try again in 2 hours 5 minutes` → ISO time, relative to `now`. */
export function codexResetsAt(message: string, now: number = Date.now()): string | null {
  const m = RETRY_IN_RE.exec(message);
  if (!m?.[1]) return null;
  let ms = 0;
  for (const part of m[1].matchAll(/(\d+)\s*([dhms])/gi)) {
    const unit = UNIT_MS[(part[2] ?? "").toLowerCase()];
    if (unit !== undefined) ms += Number(part[1]) * unit;
  }
  return ms > 0 ? new Date(now + ms).toISOString() : null;
}

function rateLimit(message: string): HarnessEvent[] {
  return LIMIT_RE.test(message) ? [{ kind: "rate_limit", resetsAt: codexResetsAt(message), detail: message }] : [];
}

function parseItem(item: z.infer<typeof ItemSchema>): HarnessEvent[] {
  const message = AgentMessageSchema.safeParse(item);
  if (message.success) return message.data.text.trim() === "" ? [] : [{ kind: "message", text: message.data.text }];
  const toolName = TOOL_ITEMS[item.type];
  if (toolName !== undefined) return [{ kind: "tool", name: toolName }];
  const mcp = McpToolCallSchema.safeParse(item);
  if (mcp.success) return [{ kind: "tool", name: [mcp.data.server, mcp.data.tool].filter(Boolean).join(".") || "mcp" }];
  if (IGNORED_ITEMS.has(item.type)) return [];
  return [{ kind: "unparsed", line: JSON.stringify(item) }];
}

function parseValue(value: unknown, line: string): HarnessEvent[] {
  const thread = ThreadStartedSchema.safeParse(value);
  if (thread.success) return [{ kind: "session", sessionId: thread.data.thread_id, model: null }];

  const completed = ItemCompletedSchema.safeParse(value);
  if (completed.success) return parseItem(completed.data.item);

  const err = ErrorSchema.safeParse(value);
  if (err.success) return rateLimit(err.data.message);

  const failed = TurnFailedSchema.safeParse(value);
  if (failed.success) {
    const text = failed.data.error.message;
    return [...rateLimit(text), { kind: "result", ok: false, text, costUsd: null, numTurns: 1, permissionDenials: 0 }];
  }

  // Codex has no final-text event: the last agent message is the report.
  if (TurnCompletedSchema.safeParse(value).success) {
    return [{ kind: "result", ok: true, text: null, costUsd: null, numTurns: 1, permissionDenials: 0 }];
  }

  if (typeof value === "object" && value !== null && "type" in value && typeof value.type === "string" && IGNORED_TYPES.has(value.type)) {
    return [];
  }
  return [{ kind: "unparsed", line }];
}

/** OpenAI Codex CLI in non-interactive mode (`codex exec --json`). */
export const codexAdapter: HarnessAdapter = {
  id: "codex",
  defaultBin: ["codex"],
  validateOptions(options) {
    CodexOptionsSchema.parse(options);
  },
  build({ prompt, pool, workdir, resumeSession }) {
    const opts = CodexOptionsSchema.parse(pool.options);
    const [exe, ...pre] = pool.bin ?? codexAdapter.defaultBin;
    if (exe === undefined) throw new Error("empty bin");
    const argv: [string, ...string[]] = [exe, ...pre, "exec", "--json", "--skip-git-repo-check", "-C", workdir];
    if (opts.bypassSandbox) argv.push("--dangerously-bypass-approvals-and-sandbox");
    else argv.push("--sandbox", opts.sandbox);
    if (pool.model !== undefined) argv.push("--model", pool.model);
    for (const [k, v] of Object.entries(opts.config)) argv.push("-c", `${k}=${v}`);
    // Exec options go before the subcommand; `resume` takes the session id then the prompt.
    if (resumeSession !== null) argv.push("resume", resumeSession);
    argv.push("--", prompt);
    return { argv, env: {} };
  },
  parseLine(line): readonly HarnessEvent[] {
    const trimmed = line.trim();
    if (trimmed === "") return [];
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return [{ kind: "unparsed", line }];
    }
    try {
      return parseValue(value, line);
    } catch {
      return [{ kind: "unparsed", line }];
    }
  },
};
