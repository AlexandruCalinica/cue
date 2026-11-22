import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parsePublicKey } from "./auth.js";
import { TERMINAL_STATUSES } from "./job.js";

const HookSchema = z.object({
  /** Executable (absolute or on PATH) and its arguments. Run without a shell. */
  run: z.array(z.string().min(1)).min(1),
  timeoutSec: z.number().positive().default(300),
  /** For pre-run hooks: whether a failure fails the job (default) or is only recorded. */
  required: z.boolean().default(true),
});

const RateSchema = z.object({
  /** Max jobs started per window for this account. */
  jobs: z.number().int().positive(),
  windowSec: z.number().int().positive(),
});

const BudgetSchema = z.object({
  usd: z.number().positive(),
  windowSec: z.number().int().positive(),
});

const PoolSchema = z.object({
  /** Adapter id registered with the daemon, e.g. `claude`. */
  harness: z.string().min(1),
  /** Account / credential profile name. Pool key is `${harness}:${account}`. */
  account: z.string().min(1).default("default"),
  concurrency: z.number().int().positive().default(1),
  /** Executable to start. Defaults to the adapter's default (e.g. `claude`). */
  bin: z.array(z.string().min(1)).min(1).optional(),
  model: z.string().min(1).optional(),
  /** Extra environment for this pool's processes. Values are not logged. */
  env: z.record(z.string(), z.string()).default({}),
  /** Adapter-specific options, validated by the adapter itself. */
  options: z.record(z.string(), z.unknown()).default({}),
  rate: RateSchema.optional(),
  /** Spend cap: the pool pauses while finished jobs in the last `windowSec` cost `usd` or more. */
  budget: BudgetSchema.optional(),
  /** Overrides `safety.onDenial` for this pool. */
  onDenial: z.enum(["flag", "block"]).optional(),
  enabled: z.boolean().default(true),
});

const RuleSchema = z.object({
  name: z.string().min(1),
  match: z
    .object({
      labels: z.array(z.string()).optional(),
      requester: z.array(z.string()).optional(),
      lane: z.array(z.string()).optional(),
      /** Verified client names (see `clients`). Unlike `requester`, a client can't claim another's name. */
      client: z.array(z.string()).optional(),
    })
    .default({}),
  /** Ordered pool keys (`harness:account`) or harness ids; the first available one wins. */
  use: z.array(z.string().min(1)).min(1),
});

/** Gateway verbs a client may be granted. `ping` is always allowed and never audited. */
export const CLIENT_VERBS = ["submit", "status", "list", "cancel", "logs", "events", "stats", "audit"] as const;
export type ClientVerb = (typeof CLIENT_VERBS)[number];

const ClientSchema = z.object({
  /** Raw Ed25519 public key, base64url (`cue keygen` prints it). */
  publicKey: z.string().min(1),
  verbs: z.array(z.enum(CLIENT_VERBS)).min(1).default(["submit", "status", "list", "cancel", "logs", "events"]),
  /** `own`: status, list, logs, events and cancel only see this client's jobs. `all`: every job. */
  scope: z.enum(["own", "all"]).default("own"),
  /** Lanes this client may submit to. Omitted: any lane, or none. */
  lanes: z.array(z.string().min(1)).min(1).optional(),
  /** Lane applied when a submission names none. */
  defaultLane: z.string().min(1).optional(),
  /** Pool keys or harness ids this client's jobs may run on. Omitted: any. */
  pools: z.array(z.string().min(1)).min(1).optional(),
  /** Most unfinished (queued, leased or running) jobs this client may have at once. */
  maxActive: z.number().int().positive().optional(),
  /** Upper bound for this client's `maxMinutes`, on top of `limits.maxMaxMinutes`. */
  maxMinutes: z.number().positive().optional(),
});

/** When a notifier fires: any terminal status, one status, or a finished job with flags. */
export const NOTIFY_ON = ["terminal", ...TERMINAL_STATUSES, "flagged"] as const;
const NotifyOnSchema = z.array(z.enum(NOTIFY_ON)).min(1).default(["terminal"]);

const NotifierSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("webhook"),
    url: z.url(),
    /** Extra request headers (e.g. authorization). Values are never logged. */
    headers: z.record(z.string(), z.string()).default({}),
    on: NotifyOnSchema,
    timeoutSec: z.number().positive().default(10),
  }),
  z.object({
    kind: z.literal("command"),
    /** Run without a shell, with the hook environment (`CUE_HOOK=notify`, `CUE_RESULT_JSON`, ...). */
    run: z.array(z.string().min(1)).min(1),
    on: NotifyOnSchema,
    timeoutSec: z.number().positive().default(30),
  }),
]);

export const CueConfigSchema = z.object({
  /** Where the SQLite file and per-job folders live. */
  dataDir: z.string().min(1).default(".cue-data"),
  node: z
    .object({
      id: z.string().min(1).default("cued"),
      /** libeam base port: rpc=port, pub=port+1, gossip(udp)=port+2. */
      port: z.number().int().min(1024).max(65530).default(47100),
      bindAddress: z.string().default("127.0.0.1"),
      advertiseAddress: z.string().optional(),
      gossipIntervalMs: z.number().int().positive().default(200),
    })
    .prefault({}),
  limits: z
    .object({
      defaultMaxMinutes: z.number().positive().default(60),
      maxMaxMinutes: z.number().positive().default(240),
      leaseTtlSec: z.number().int().positive().default(30),
      maxAttempts: z.number().int().positive().default(3),
      tickMs: z.number().int().positive().default(500),
    })
    .prefault({}),
  isolation: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("process-group") }),
      z.object({
        kind: z.literal("systemd-scope"),
        memoryMax: z.string().default("4G"),
        cpuQuota: z.string().default("200%"),
        tasksMax: z.number().int().positive().default(512),
      }),
    ])
    .default({ kind: "process-group" }),
  pools: z.array(PoolSchema).min(1),
  lanes: z.record(z.string(), z.object({ concurrency: z.number().int().positive(), enabled: z.boolean().default(true) })).default({}),
  routing: z.array(RuleSchema).default([]),
  hooks: z
    .object({
      preRun: z.array(HookSchema).default([]),
      postRun: z.array(HookSchema).default([]),
      onComplete: z.array(HookSchema).default([]),
    })
    .prefault({}),
  notify: z.array(NotifierSchema).default([]),
  /**
   * Known clients by name. When any are configured every Gateway call must be
   * signed by one of them; with none the Gateway accepts unsigned calls.
   */
  clients: z.record(z.string().regex(/^[A-Za-z0-9._@-]{1,200}$/), ClientSchema).default({}),
  auth: z
    .object({
      /** Accepted difference between a request's timestamp and the daemon's clock. */
      clockSkewSec: z.number().int().positive().max(3600).default(60),
    })
    .prefault({}),
  safety: z
    .object({
      /**
       * What a permission denial inside the harness does to the job: `flag` adds the
       * `permission-denied` flag and keeps the status; `block` ends the job as `blocked`.
       */
      onDenial: z.enum(["flag", "block"]).default("flag"),
    })
    .prefault({}),
});

export type CueConfig = z.infer<typeof CueConfigSchema>;
export type CueConfigInput = z.input<typeof CueConfigSchema>;
export type PoolConfig = CueConfig["pools"][number];
export type HookConfig = CueConfig["hooks"]["preRun"][number];
export type RuleConfig = CueConfig["routing"][number];
export type NotifierConfig = CueConfig["notify"][number];
export type ClientConfig = CueConfig["clients"][string];

export function poolKey(pool: Pick<PoolConfig, "harness" | "account">): string {
  return `${pool.harness}:${pool.account}`;
}

export function parseConfig(input: unknown): CueConfig {
  const config = CueConfigSchema.parse(input);
  const keys = config.pools.map(poolKey);
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup) throw new Error(`duplicate pool ${dup}`);
  const seen = new Map<string, string>();
  for (const [name, client] of Object.entries(config.clients)) {
    try {
      parsePublicKey(client.publicKey);
    } catch (err) {
      throw new Error(`client ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const other = seen.get(client.publicKey);
    if (other !== undefined) throw new Error(`clients ${other} and ${name} share a public key`);
    seen.set(client.publicKey, name);
    if (client.defaultLane !== undefined && client.lanes !== undefined && !client.lanes.includes(client.defaultLane)) {
      throw new Error(`client ${name}: defaultLane ${client.defaultLane} is not in its lanes`);
    }
  }
  return config;
}

export function loadConfig(path: string): CueConfig {
  return parseConfig(parseYaml(readFileSync(path, "utf8")));
}
