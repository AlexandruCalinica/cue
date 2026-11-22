#!/usr/bin/env node
// A stand-in for `claude -p <prompt> --output-format stream-json`. The prompt is a
// `;`-separated script: say <text> | sleep <sec> | deny <tool> | env <NAME> | pwd |
// touch <path> | ignore-term | ratelimit | fail <msg> | exit <code>
import { writeFileSync } from "node:fs";
import process from "node:process";
import { setTimeout } from "node:timers";

const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1] ?? "";
const session = `fake-${process.pid}`;
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const say = (text) => out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, session_id: session });
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

out({ type: "system", subtype: "init", session_id: session, model: "fake-model", cwd: process.cwd(), tools: ["Bash"] });
let last = "";
let denials = [];
for (const raw of prompt.split(/;|\n\n/)) {
  const step = raw.trim();
  if (step === "") continue;
  const [cmd, ...rest] = step.split(" ");
  const arg = rest.join(" ");
  switch (cmd) {
    case "say": last = arg; say(arg); break;
    case "sleep": await sleep(Number(arg)); break;
    case "env": last = process.env[arg] ?? "<unset>"; say(last); break;
    case "pwd": last = process.cwd(); say(last); break;
    case "touch": writeFileSync(arg, "x"); break;
    case "ignore-term": process.on("SIGTERM", () => {}); break;
    case "deny":
      out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: arg, input: {} }] }, session_id: session });
      out({ type: "system", subtype: "permission_denied", tool_name: arg, tool_use_id: "t1", message: `${arg} needs approval`, session_id: session });
      denials.push({ tool_name: arg, tool_use_id: "t1", tool_input: {} });
      break;
    case "ratelimit":
      out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: "five_hour" }, session_id: session });
      out({ type: "result", subtype: "success", is_error: true, result: "You've hit your limit · resets 3pm (UTC)", num_turns: 1, total_cost_usd: 0, permission_denials: [], session_id: session });
      process.exit(1);
      break;
    case "fail":
      out({ type: "result", subtype: "error_during_execution", is_error: true, result: arg, num_turns: 1, total_cost_usd: 0.01, permission_denials: denials, session_id: session });
      process.exit(1);
      break;
    case "exit": process.exit(Number(arg)); break;
    default: last = step; say(step);
  }
}
out({ type: "result", subtype: "success", is_error: false, result: last, num_turns: 1, total_cost_usd: 0.02, permission_denials: denials, session_id: session });
