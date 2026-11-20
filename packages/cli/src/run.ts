import type { JobRecordView } from "@cue/daemon";
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

function summary(rec: JobRecordView): string {
  const lines = [
    `${rec.id}  ${rec.status}${rec.cancelRequested && rec.status !== "cancelled" ? " (cancel requested)" : ""}`,
    `  requester ${rec.spec.requester}  pool ${rec.pool ?? "-"}  attempt ${rec.attempt}  phase ${rec.phase ?? "-"}`,
    `  created ${rec.createdAt}  started ${rec.startedAt ?? "-"}  finished ${rec.finishedAt ?? "-"}`,
  ];
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
  const head = ["ID", "STATUS", "POOL", "REQUESTER", "CREATED", "PROMPT"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)));
  const fmt = (row: readonly string[]) => row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join("  ");
  return [fmt(head), ...rows.map(fmt)].join("\n");
}

/** Executes one parsed command against the gateway. Returns the process exit code. */
export async function runCommand(command: Exclude<Command, { kind: "help" }>, gateway: GatewayClient, io: Io): Promise<number> {
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
    case "logs": {
      const lines = await gateway.logs({ id: command.id, lines: command.lines });
      io.out(lines.length > 0 ? `${lines.join("\n")}\n` : "");
      return 0;
    }
  }
}
