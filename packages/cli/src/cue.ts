#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { createSigner, generateClientKey, parsePrivateKey } from "@cue/core";
import type { Signer } from "@cue/daemon/protocol";
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

/** Signer from CUE_CLIENT + CUE_KEY_FILE; both or neither must be set. */
async function signerFromEnv(): Promise<Signer | undefined> {
  const client = process.env["CUE_CLIENT"];
  const keyFile = process.env["CUE_KEY_FILE"];
  if (!client && !keyFile) return undefined;
  if (!client || !keyFile) throw new Error("set both CUE_CLIENT and CUE_KEY_FILE, or neither");
  let key;
  try {
    key = parsePrivateKey(await readFile(keyFile, "utf8"));
  } catch (err) {
    throw new Error(`CUE_KEY_FILE ${keyFile}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return createSigner(client, key);
}

async function main(): Promise<number> {
  const command = parseCommand(process.argv.slice(2));
  if (command.kind === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (command.kind === "keygen") {
    const { privateKeyPem, publicKey } = generateClientKey();
    if (command.out === null) process.stdout.write(privateKeyPem);
    else await writeFile(command.out, privateKeyPem, { mode: 0o600, flag: "wx" });
    process.stderr.write(`public key: ${publicKey}\n`);
    return 0;
  }
  const signer = await signerFromEnv();
  loggerConfig.level = process.env["CUE_LOG_LEVEL"] === "debug" ? "debug" : "none";
  const seeds = (process.env["CUE_SEEDS"] ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  const address = process.env["CUE_CLIENT_ADDRESS"];
  const timeoutMs = Number(process.env["CUE_CONNECT_TIMEOUT_MS"] ?? "");
  const client = await connect({
    seeds,
    cookie: process.env["CUE_COOKIE"] ?? "",
    ...(signer ? { signer } : {}),
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
