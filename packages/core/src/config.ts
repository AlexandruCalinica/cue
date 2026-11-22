import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

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
  enabled: z.boolean().default(true),
});

const RuleSchema = z.object({
  name: z.string().min(1),
  match: z
    .object({
      labels: z.array(z.string()).optional(),
      requester: z.array(z.string()).optional(),
      lane: z.array(z.string()).optional(),
    })
    .default({}),
  /** Ordered pool keys (`harness:account`) or harness ids; the first available one wins. */
  use: z.array(z.string().min(1)).min(1),
});

const NotifierSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("webhook"), url: z.url(), on: z.array(z.string()).default(["terminal"]) }),
  z.object({ kind: z.literal("command"), run: z.array(z.string().min(1)).min(1), on: z.array(z.string()).default(["terminal"]) }),
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
});

export type CueConfig = z.infer<typeof CueConfigSchema>;
export type CueConfigInput = z.input<typeof CueConfigSchema>;
export type PoolConfig = CueConfig["pools"][number];
export type HookConfig = CueConfig["hooks"]["preRun"][number];
export type RuleConfig = CueConfig["routing"][number];
export type NotifierConfig = CueConfig["notify"][number];

export function poolKey(pool: Pick<PoolConfig, "harness" | "account">): string {
  return `${pool.harness}:${pool.account}`;
}

export function parseConfig(input: unknown): CueConfig {
  const config = CueConfigSchema.parse(input);
  const keys = config.pools.map(poolKey);
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup) throw new Error(`duplicate pool ${dup}`);
  return config;
}

export function loadConfig(path: string): CueConfig {
  return parseConfig(parseYaml(readFileSync(path, "utf8")));
}
