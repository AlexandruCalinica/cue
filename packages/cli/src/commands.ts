import { parseArgs } from "node:util";

export type Command =
  | { readonly kind: "submit"; readonly file: string | null }
  | { readonly kind: "status"; readonly id: string; readonly json: boolean }
  | { readonly kind: "list"; readonly limit: number; readonly json: boolean }
  | { readonly kind: "cancel"; readonly id: string }
  | { readonly kind: "logs"; readonly id: string; readonly lines: number }
  | { readonly kind: "help" };

export const USAGE = `usage:
  cue submit [file.json]        submit a job (JSON on stdin when no file), prints its id
  cue status <id> [--json]      state of one job
  cue list [-n N] [--json]      recent jobs
  cue cancel <id>               cancel a queued job or kill a running one
  cue logs <id> [-n LINES]      tail of the job's harness output

connection: CUE_SEEDS (host:gossipPort,...), CUE_COOKIE (cluster secret)`;

/** Pure argv parsing so the CLI contract is testable without a cluster. */
export function parseCommand(argv: readonly string[]): Command {
  const [verb, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: [...rest],
    allowPositionals: true,
    options: { json: { type: "boolean", default: false }, n: { type: "string", short: "n" } },
  });
  const id = positionals[0];
  const n = values.n === undefined ? undefined : Number.parseInt(values.n, 10);
  switch (verb) {
    case "submit":
      return { kind: "submit", file: positionals[0] ?? null };
    case "status":
      return id ? { kind: "status", id, json: values.json } : { kind: "help" };
    case "list":
      return { kind: "list", limit: n ?? 20, json: values.json };
    case "cancel":
      return id ? { kind: "cancel", id } : { kind: "help" };
    case "logs":
      return id ? { kind: "logs", id, lines: n ?? 100 } : { kind: "help" };
    default:
      return { kind: "help" };
  }
}
