import { z } from "zod";
import type { HarnessAdapter, HarnessEvent } from "../harness.js";

const InitSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string(),
  model: z.string().nullish(),
});

const PermissionDeniedSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("permission_denied"),
  tool_name: z.string(),
  message: z.string().nullish(),
});

const TextBlockSchema = z.object({ type: z.literal("text"), text: z.string() });
const ToolUseBlockSchema = z.object({ type: z.literal("tool_use"), name: z.string() });

const AssistantSchema = z.object({
  type: z.literal("assistant"),
  message: z.object({ content: z.array(z.unknown()) }),
});

const RateLimitSchema = z.object({
  type: z.literal("rate_limit_event"),
  rate_limit_info: z.looseObject({
    status: z.string(),
    resetsAt: z.number().nullish(),
    rateLimitType: z.string().nullish(),
  }),
});

const ResultSchema = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().nullish(),
  num_turns: z.number().nullish(),
  total_cost_usd: z.number().nullish(),
  permission_denials: z.array(z.unknown()).nullish(),
});

/** Message types Claude Code emits that carry nothing cue needs. */
const IGNORED_TYPES = new Set(["user", "system", "stream_event"]);

/** Legacy usage-limit text: `Claude AI usage limit reached|<epoch seconds>`. */
const LEGACY_LIMIT_RE = /usage limit reached\|(\d+)/i;
/** Current wording, e.g. `You've hit your limit · resets 3pm (UTC)`. */
const LIMIT_TEXT_RE = /(hit your limit|usage limit reached|limit reached\b.*resets)/i;

const isoFromEpochSeconds = (s: number | null | undefined) => (typeof s === "number" && s > 0 ? new Date(s * 1000).toISOString() : null);

function parseValue(value: unknown, line: string): HarnessEvent[] {
  const init = InitSchema.safeParse(value);
  if (init.success) return [{ kind: "session", sessionId: init.data.session_id, model: init.data.model ?? null }];

  const denied = PermissionDeniedSchema.safeParse(value);
  if (denied.success) return [{ kind: "denial", tool: denied.data.tool_name, detail: denied.data.message ?? "" }];

  const assistant = AssistantSchema.safeParse(value);
  if (assistant.success) {
    const events: HarnessEvent[] = [];
    for (const raw of assistant.data.message.content) {
      const text = TextBlockSchema.safeParse(raw);
      if (text.success) {
        if (text.data.text.trim() !== "") events.push({ kind: "message", text: text.data.text });
        continue;
      }
      const tool = ToolUseBlockSchema.safeParse(raw);
      if (tool.success) events.push({ kind: "tool", name: tool.data.name });
    }
    return events;
  }

  const limit = RateLimitSchema.safeParse(value);
  if (limit.success) {
    const info = limit.data.rate_limit_info;
    if (info.status !== "rejected") return [];
    return [
      {
        kind: "rate_limit",
        resetsAt: isoFromEpochSeconds(info.resetsAt),
        detail: `${info.rateLimitType ?? "rate"} limit rejected`,
      },
    ];
  }

  const result = ResultSchema.safeParse(value);
  if (result.success) {
    const r = result.data;
    const text = r.result ?? (r.is_error ? r.subtype : "");
    const events: HarnessEvent[] = [];
    if (r.is_error && LIMIT_TEXT_RE.test(text)) {
      const legacy = LEGACY_LIMIT_RE.exec(text);
      events.push({ kind: "rate_limit", resetsAt: isoFromEpochSeconds(legacy ? Number(legacy[1]) : null), detail: text });
    }
    events.push({
      kind: "result",
      ok: !r.is_error && r.subtype === "success",
      text,
      costUsd: r.total_cost_usd ?? null,
      numTurns: r.num_turns ?? null,
      permissionDenials: r.permission_denials?.length ?? 0,
    });
    return events;
  }

  if (typeof value === "object" && value !== null && "type" in value && typeof value.type === "string" && IGNORED_TYPES.has(value.type)) {
    return [];
  }
  return [{ kind: "unparsed", line }];
}

/** Claude Code in headless mode (`claude -p ... --output-format stream-json --verbose`). */
export const claudeAdapter: HarnessAdapter = {
  id: "claude",
  defaultBin: ["claude"],
  build({ prompt, pool, resumeSession }) {
    const bin = pool.bin ?? claudeAdapter.defaultBin;
    const [exe, ...pre] = bin;
    if (exe === undefined) throw new Error("empty bin");
    const argv: [string, ...string[]] = [exe, ...pre, "-p", prompt, "--output-format", "stream-json", "--verbose"];
    if (resumeSession !== null) argv.push("--resume", resumeSession);
    if (pool.model !== undefined) argv.push("--model", pool.model);
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
