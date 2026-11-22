import { randomBytes } from "node:crypto";
import { createSystem, type System } from "libeam";
import { GATEWAY_NAME, gatewayClient, type GatewayClient, type Signer } from "@cue/daemon/protocol";

/**
 * The CLI is itself a short-lived libeam node: it joins the cluster via
 * seeds (gossip `host:port`) with the shared cookie, looks up `cue.gateway`
 * and calls it directly.
 */
export interface ClientOptions {
  readonly seeds: readonly string[];
  readonly cookie: string;
  /** Address this client binds and advertises (default 127.0.0.1). */
  readonly address?: string;
  /** Base port for this client (rpc, rpc+1, rpc+2). Default: random. */
  readonly port?: number;
  /** How long to wait for the gateway to appear. Default 10 s. */
  readonly timeoutMs?: number;
  /** Signs each request; omit for daemons without `clients`. */
  readonly signer?: Signer;
}

export interface CueClient {
  readonly gateway: GatewayClient;
  close(): Promise<void>;
}

const randomPort = () => 20000 + 3 * Math.floor(Math.random() * 10000);

async function join(options: ClientOptions): Promise<System> {
  const address = options.address ?? "127.0.0.1";
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await createSystem({
        type: "distributed",
        nodeId: `cue-cli-${process.pid}-${randomBytes(3).toString("hex")}`,
        port: options.port ?? randomPort(),
        bindAddress: address,
        advertiseAddress: address,
        seedNodes: [...options.seeds],
        cookie: options.cookie,
        gossip: { gossipIntervalMs: 100, cleanupIntervalMs: 2000, failureTimeoutMs: 5000, gossipFanout: 3, seedNodes: [...options.seeds] },
      });
    } catch (err) {
      lastError = err;
      if (options.port !== undefined || !/EADDRINUSE|in use/i.test(String(err))) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function connect(options: ClientOptions): Promise<CueClient> {
  if (options.seeds.length === 0) throw new Error("no seeds: set CUE_SEEDS to the daemon's gossip address (host:port+2)");
  if (options.cookie.length < 16) throw new Error("CUE_COOKIE must be at least 16 characters");
  const system = await join(options);
  const until = Date.now() + (options.timeoutMs ?? 10_000);
  try {
    for (;;) {
      const ref = await system.getActorByName(GATEWAY_NAME);
      if (ref) return { gateway: gatewayClient(ref, options.signer ? { signer: options.signer } : {}), close: () => system.shutdown() };
      if (Date.now() > until) throw new Error(`no ${GATEWAY_NAME} reachable via ${options.seeds.join(", ")}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  } catch (err) {
    await system.shutdown();
    throw err;
  }
}
