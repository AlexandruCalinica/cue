import { join } from "node:path";
import { createSystem, type System } from "libeam";
import type { CueConfig } from "@cue/core";
import type { HarnessAdapter } from "@cue/harness";
import { openSqliteStore } from "@cue/store";
import { Gateway } from "./actors/gateway.js";
import { Scheduler } from "./actors/scheduler.js";
import { createScriptHookRunner, type HookRunner } from "./hooks.js";
import { createProcessController, type ProcessController } from "./process.js";
import { GATEWAY_NAME, gatewayClient, type GatewayClient, type Signer } from "./protocol.js";
import { createNotifier } from "./notify.js";
import { ensureDir, errorMessage, poolMap, type Runtime } from "./runtime.js";

/**
 * Supervision tree:
 *
 *   libeam system
 *   ├── Gateway     named "cue.gateway"; validates, routes, writes jobs, pokes the scheduler
 *   └── Scheduler   reclaims expired leases, leases queued jobs per pool within concurrency and quota,
 *       │           adopts this node's jobs after a restart
 *       └── JobActor   one per attempt; walks prepare → run → post → finalize from the stored phase,
 *                      owns its harness process (start, tail, cancel, timeout) through the ProcessController
 *
 * Harness processes are detached: stopping the daemon leaves them running and
 * a restarted daemon (same node id) re-attaches to them.
 */
export interface CuedOptions {
  readonly config: CueConfig;
  readonly adapters: readonly HarnessAdapter[];
  /**
   * `distributed` (default) joins/forms a libeam cluster on `config.node.port`
   * so `cue` client nodes can reach the gateway. `local` runs without any
   * network listener (tests, embedding).
   */
  readonly network?: { readonly kind: "distributed"; readonly cookie?: string } | { readonly kind: "local" };
  readonly processes?: ProcessController;
  readonly hooks?: HookRunner;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly killGraceMs?: number;
}

export interface Cued {
  readonly nodeId: string;
  /** In-process Gateway client sending unsigned requests (enough when no `clients` are configured). */
  readonly gateway: GatewayClient;
  /** In-process Gateway client whose requests are wrapped by `signer`. */
  gatewayAs(signer: Signer): GatewayClient;
  readonly system: System;
  /** Stops the actors and closes the store. Harness processes keep running. */
  shutdown(): Promise<void>;
}

export async function startCued(options: CuedOptions): Promise<Cued> {
  const { config } = options;
  ensureDir(config.dataDir);
  const store = openSqliteStore(join(config.dataDir, "cue.db"));
  const hooks = options.hooks ?? createScriptHookRunner();
  const rt: Runtime = {
    config,
    store,
    adapters: new Map(options.adapters.map((a) => [a.id, a])),
    processes: options.processes ?? createProcessController(config.isolation),
    hooks,
    notify: createNotifier({ notifiers: config.notify, hooks, store }),
    owner: config.node.id,
    pools: poolMap(config),
    baseEnv: options.baseEnv ?? process.env,
    killGraceMs: options.killGraceMs ?? 10_000,
    now: () => Date.now(),
  };
  for (const pool of config.pools) {
    const adapter = rt.adapters.get(pool.harness);
    if (!adapter) {
      store.close();
      throw new Error(`pool ${pool.harness}:${pool.account} uses unknown harness "${pool.harness}"`);
    }
    try {
      adapter.validateOptions?.(pool.options);
    } catch (err) {
      store.close();
      throw new Error(`pool ${pool.harness}:${pool.account} has invalid options: ${errorMessage(err)}`);
    }
  }

  const network = options.network ?? { kind: "distributed" };
  let system: System;
  try {
    if (network.kind === "local") {
      system = createSystem({ nodeId: config.node.id });
    } else {
      const cookie = network.cookie ?? process.env["CUE_COOKIE"];
      if (cookie === undefined || cookie.length < 16) throw new Error("CUE_COOKIE (at least 16 characters) is required");
      system = await createSystem({
        type: "distributed",
        nodeId: config.node.id,
        port: config.node.port,
        bindAddress: config.node.bindAddress,
        ...(config.node.advertiseAddress === undefined ? {} : { advertiseAddress: config.node.advertiseAddress }),
        seedNodes: [],
        cookie,
        gossip: {
          gossipIntervalMs: config.node.gossipIntervalMs,
          cleanupIntervalMs: 2000,
          failureTimeoutMs: 5000,
          gossipFanout: 3,
          seedNodes: [],
        },
      });
    }
  } catch (err) {
    store.close();
    throw err;
  }

  const scheduler = system.spawn(Scheduler, { args: [rt] });
  const gateway = system.spawn(Gateway, { name: GATEWAY_NAME, args: [rt, scheduler] });

  let closed = false;
  return {
    nodeId: system.nodeId,
    gateway: gatewayClient(gateway),
    gatewayAs: (signer) => gatewayClient(gateway, { signer }),
    system,
    async shutdown() {
      if (closed) return;
      closed = true;
      await system.shutdown();
      store.close();
    },
  };
}
