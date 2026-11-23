#!/usr/bin/env node
import { loggerConfig } from "libeam";
import { loadConfig } from "@cue/core";
import { claudeAdapter, codexAdapter } from "@cue/harness";
import { startCued } from "./daemon.js";

const configPath = process.argv[2] ?? "cue.yaml";
const level = process.env["CUE_LOG_LEVEL"];
loggerConfig.level = level === "debug" || level === "info" || level === "error" || level === "none" ? level : "warn";

async function main(): Promise<void> {
  const config = loadConfig(configPath);
  const cued = await startCued({ config, adapters: [claudeAdapter, codexAdapter] });
  const { port, bindAddress } = config.node;
  process.stderr.write(`cued: node ${cued.nodeId} up; clients use CUE_SEEDS=${config.node.advertiseAddress ?? bindAddress}:${port + 2}\n`);
  if (Object.keys(config.clients).length === 0) {
    process.stderr.write("cued: warning: no clients configured, so anyone with CUE_COOKIE can call every verb (see `clients` in cue.yaml)\n");
  }

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`cued: ${signal}, shutting down (running harnesses keep going and are re-attached on restart)\n`);
    cued.shutdown().then(
      () => process.exit(0),
      (err: unknown) => {
        process.stderr.write(`cued: shutdown failed: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((error: unknown) => {
  process.stderr.write(`cued: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
