#!/usr/bin/env node
import { loadConfig } from "@cue/core";
import { claudeAdapter } from "@cue/harness";
import { startCued } from "./daemon.js";

const configPath = process.argv[2] ?? "cue.yaml";
const config = loadConfig(configPath);
startCued({ config, adapters: [claudeAdapter] }).catch((error: unknown) => {
  process.stderr.write(`cued: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
