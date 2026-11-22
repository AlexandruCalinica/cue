#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { loggerConfig } from "libeam";
import { connect } from "./client.js";
import { parseCommand, USAGE } from "./commands.js";
import { runCommand } from "./run.js";

async function readInput(path: string | null): Promise<string> {
  if (path !== null) return readFile(path, "utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  const command = parseCommand(process.argv.slice(2));
  if (command.kind === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  loggerConfig.level = process.env["CUE_LOG_LEVEL"] === "debug" ? "debug" : "none";
  const seeds = (process.env["CUE_SEEDS"] ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  const address = process.env["CUE_CLIENT_ADDRESS"];
  const timeoutMs = Number(process.env["CUE_CONNECT_TIMEOUT_MS"] ?? "");
  const client = await connect({
    seeds,
    cookie: process.env["CUE_COOKIE"] ?? "",
    ...(address ? { address } : {}),
    ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
  });
  try {
    return await runCommand(command, client.gateway, {
      out: (t) => process.stdout.write(t),
      err: (t) => process.stderr.write(t),
      read: readInput,
      requester: process.env["CUE_REQUESTER"] ?? userInfo().username,
    });
  } finally {
    await client.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`cue: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
