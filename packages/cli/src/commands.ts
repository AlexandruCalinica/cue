import { parseArgs } from "node:util";

export type Command =
  | { readonly kind: "submit"; readonly file: string | null }
  | { readonly kind: "status"; readonly id: string; readonly json: boolean }
  | { readonly kind: "list"; readonly limit: number; readonly json: boolean }
  | { readonly kind: "cancel"; readonly id: string }
  | { readonly kind: "logs"; readonly id: string; readonly lines: number }
  | { readonly kind: "stats"; readonly json: boolean }
  | { readonly kind: "audit"; readonly limit: number; readonly client: string | null; readonly json: boolean }
  | { readonly kind: "keygen"; readonly out: string | null }
  | { readonly kind: "help" };

export const USAGE = `usage:
  cue submit [file.json]        submit a job (JSON on stdin when no file), prints its id
  cue status <id> [--json]      state of one job
  cue list [-n N] [--json]      recent jobs
  cue cancel <id>               cancel a queued job or kill a running one
  cue logs <id> [-n LINES]      tail of the job's harness output
  cue stats [--json]            running jobs, pauses, budgets and lanes
  cue audit [-n N] [--client NAME] [--json]
                                recent audited gateway calls (submits, cancels, rejections)
  cue keygen [--out FILE]       new client key: private key to FILE (mode 0600) or stdout,
                                public key (for cue.yaml clients.<name>.publicKey) to stderr

connection: CUE_SEEDS (host:gossipPort,... where gossipPort = daemon port + 2), CUE_COOKIE (cluster secret)
identity:   CUE_CLIENT (client name in cue.yaml), CUE_KEY_FILE (private key from cue keygen);
            required when the daemon has clients configured
optional:   CUE_REQUESTER (default: OS user), CUE_CLIENT_ADDRESS (bind/advertise, default 127.0.0.1),
            CUE_CONNECT_TIMEOUT_MS (default 10000)`;

/** Pure argv parsing so the CLI contract is testable without a cluster. */
export function parseCommand(argv: readonly string[]): Command {
  const [verb, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: [...rest],
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      n: { type: "string", short: "n" },
      out: { type: "string" },
      client: { type: "string" },
    },
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
    case "stats":
      return { kind: "stats", json: values.json };
    case "audit":
      return { kind: "audit", limit: n ?? 50, client: values.client ?? null, json: values.json };
    case "keygen":
      return { kind: "keygen", out: values.out ?? null };
    default:
      return { kind: "help" };
  }
}
