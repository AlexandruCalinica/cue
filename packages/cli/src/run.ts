import type { AuditRecord, JobRecordView, SchedulerStats, WaitReason } from "@cue/daemon";
import type { GatewayClient } from "@cue/daemon/protocol";
import type { Command } from "./commands.js";

export interface Io {
  out(text: string): void;
  err(text: string): void;
  /** Reads a file, or stdin when `path` is null. */
  read(path: string | null): Promise<string>;
  /** Default requester when the spec has none (e.g. the OS user). */
  readonly requester: string;
}

const BLOCKER_TEXT: Readonly<Record<string, string>> = {
  disabled: "disabled",
  full: "at its concurrency limit",
  paused: "paused after a rate limit",
  rate: "start rate limit reached",
  "over-budget": "over its spend budget",
};

const time = (ms: number) => new Date(ms).toISOString();

/** One line per reason a queued job is still waiting. */
export function describeWait(reason: WaitReason): string {
  switch (reason.kind) {
    case "pool": {
      const until = reason.until === null ? "" : ` until ${time(reason.until)}`;
      return `pool ${reason.pool} ${BLOCKER_TEXT[reason.blocker] ?? reason.blocker}${until}`;
    }
    case "unknown-pool":
      return `pool ${reason.pool} is no longer configured`;
    case "lane":
      return `lane ${reason.lane} ${reason.blocker === "full" ? "at its concurrency limit" : "disabled"}`;
    case "queue":
      return `pool ${reason.pool} has room; other jobs are ahead`;
  }
}

/** Human-readable `stats`. */
export function formatStats(stats: SchedulerStats, now: number = Date.now()): string {
  const pools = new Set([...Object.keys(stats.running), ...Object.keys(stats.paused), ...Object.keys(stats.budgets)]);
  const lines: string[] = [];
  if (pools.size === 0) lines.push("no pool activity yet");
  else {
    const rows = [...pools].sort().map((pool) => {
      const until = stats.paused[pool];
      const budget = stats.budgets[pool];
      return [
        pool,
        String(stats.running[pool]?.length ?? 0),
        until !== undefined && until !== null && until > now ? `until ${time(until)}` : "-",
        budget ? `$${budget.spentUsd.toFixed(2)} / $${budget.limitUsd.toFixed(2)}${budget.exceeded ? " (exceeded)" : ""}` : "-",
      ];
    });
    lines.push(...columns(["POOL", "RUNNING", "PAUSED", "SPEND"], rows));
  }
  const lanes = Object.entries(stats.lanes).sort(([a], [b]) => a.localeCompare(b));
  if (lanes.length > 0) {
    lines.push("");
    const rows = lanes.map(([name, l]) => [name, String(l.active), l.concurrency === null ? "-" : String(l.concurrency), l.enabled ? "yes" : "no"]);
    lines.push(...columns(["LANE", "ACTIVE", "CAP", "ENABLED"], rows));
  }
  return lines.join("\n");
}

function columns(head: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)));
  const fmt = (row: readonly string[]) => row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join("  ");
  return [fmt(head), ...rows.map(fmt)];
}

function summary(rec: JobRecordView): string {
  const lines = [
    `${rec.id}  ${rec.status}${rec.cancelRequested && rec.status !== "cancelled" ? " (cancel requested)" : ""}`,
    `  ${rec.client === null ? "" : `client ${rec.client}  `}requester ${rec.spec.requester}  pool ${rec.pool ?? "-"}  attempt ${rec.attempt}  phase ${rec.phase ?? "-"}`,
    `  created ${rec.createdAt}  started ${rec.startedAt ?? "-"}  finished ${rec.finishedAt ?? "-"}`,
  ];
  if (rec.waiting !== undefined && rec.waiting.length > 0) {
    lines.push("  waiting:", ...rec.waiting.map((w) => `    ${describeWait(w)}`));
  }
  const r = rec.result;
  if (r) {
    if (r.error) lines.push(`  error: ${r.error}`);
    if (r.flags.length > 0) lines.push(`  flags: ${r.flags.join(", ")}`);
    if (r.costUsd !== null) lines.push(`  cost: $${r.costUsd.toFixed(4)}  turns: ${r.numTurns ?? "-"}`);
    if (r.report) lines.push("", r.report);
  }
  return lines.join("\n");
}

function table(records: readonly JobRecordView[]): string {
  const rows = records.map((r) => [r.id, r.status, r.pool ?? "-", r.spec.requester, r.createdAt, r.spec.prompt.replace(/\s+/g, " ").slice(0, 50)]);
  return columns(["ID", "STATUS", "POOL", "REQUESTER", "CREATED", "PROMPT"], rows).join("\n");
}

function auditTable(records: readonly AuditRecord[]): string {
  const rows = records.map((a) => [a.at, a.client ?? "-", a.method, a.ok ? "ok" : "denied", a.jobId ?? "-", a.reason ?? ""]);
  return columns(["AT", "CLIENT", "METHOD", "RESULT", "JOB", "REASON"], rows).join("\n");
}

/** Commands that talk to the daemon (everything except `help` and `keygen`). */
export type RemoteCommand = Exclude<Command, { kind: "help" } | { kind: "keygen" }>;

/** Executes one parsed command against the gateway. Returns the process exit code. */
export async function runCommand(command: RemoteCommand, gateway: GatewayClient, io: Io): Promise<number> {
  switch (command.kind) {
    case "submit": {
      const text = await io.read(command.file);
      let spec: unknown;
      try {
        spec = JSON.parse(text);
      } catch {
        io.err("submit: input is not JSON\n");
        return 2;
      }
      if (typeof spec === "object" && spec !== null && !Array.isArray(spec) && !("requester" in spec)) {
        spec = { ...spec, requester: io.requester };
      }
      const reply = await gateway.submit(spec);
      io.out(`${reply.id}\n`);
      return 0;
    }
    case "status": {
      const rec = await gateway.status(command.id);
      if (!rec) {
        io.err(`no such job: ${command.id}\n`);
        return 1;
      }
      io.out(command.json ? `${JSON.stringify(rec, null, 2)}\n` : `${summary(rec)}\n`);
      return 0;
    }
    case "list": {
      const recs = await gateway.list({ limit: command.limit });
      io.out(command.json ? `${JSON.stringify(recs, null, 2)}\n` : `${table(recs)}\n`);
      return 0;
    }
    case "cancel": {
      const reply = await gateway.cancel(command.id);
      io.out(reply.accepted ? `${reply.id}: cancel accepted (${reply.status})\n` : `${reply.id}: already ${reply.status}\n`);
      return reply.accepted ? 0 : 1;
    }
    case "stats": {
      const stats = await gateway.stats();
      io.out(command.json ? `${JSON.stringify(stats, null, 2)}\n` : `${formatStats(stats)}\n`);
      return 0;
    }
    case "audit": {
      const records = await gateway.audit({ limit: command.limit, ...(command.client === null ? {} : { client: command.client }) });
      io.out(command.json ? `${JSON.stringify(records, null, 2)}\n` : `${auditTable(records)}\n`);
      return 0;
    }
    case "logs": {
      const lines = await gateway.logs({ id: command.id, lines: command.lines });
      io.out(lines.length > 0 ? `${lines.join("\n")}\n` : "");
      return 0;
    }
  }
}
