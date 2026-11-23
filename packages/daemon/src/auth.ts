import type { KeyObject } from "node:crypto";
import { parsePublicKey, SignedRequestSchema, verifySignature, type ClientConfig, type ClientVerb, type CueConfig } from "@cue/core";
import type { Store } from "@cue/store";

/** A client error; the message is meant for the person running `cue`. */
export class GatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayError";
  }
}

/** A rejected call. Carries the claimed client name (when one was given) for the audit log. */
export class AuthError extends GatewayError {
  constructor(
    reason: string,
    readonly claimedClient: string | null,
  ) {
    super(`unauthorized: ${reason}`);
    this.name = "AuthError";
  }
}

/** The authenticated caller of one Gateway call. */
export type Caller =
  /** The daemon has no `clients`: unsigned calls are accepted and nothing is restricted. */
  | { readonly kind: "open" }
  | { readonly kind: "client"; readonly name: string; readonly config: ClientConfig };

export const clientName = (caller: Caller): string | null => (caller.kind === "client" ? caller.name : null);

/** Whether `caller` may see or act on a job submitted by `owner`. */
export function canSee(caller: Caller, owner: string | null): boolean {
  return caller.kind === "open" || caller.config.scope === "all" || owner === caller.name;
}

export interface Authenticator {
  /** Whether any clients are configured (signatures required). */
  readonly required: boolean;
  /** Verifies a request and returns its caller and arguments, or throws {@link AuthError}. */
  authenticate(method: ClientVerb, request: unknown, now: number): { caller: Caller; args: readonly unknown[] };
}

export function createAuthenticator(config: CueConfig, store: Store): Authenticator {
  const keys = new Map<string, { key: KeyObject; config: ClientConfig }>();
  for (const [name, client] of Object.entries(config.clients)) keys.set(name, { key: parsePublicKey(client.publicKey), config: client });
  const skewMs = config.auth.clockSkewSec * 1000;
  const required = keys.size > 0;

  return {
    required,
    authenticate(method, request, now) {
      const parsed = SignedRequestSchema.safeParse(request);
      if (!parsed.success) throw new AuthError("malformed request (is the cue client older than the daemon?)", null);
      const { auth, args } = parsed.data;
      if (!required) return { caller: { kind: "open" }, args };
      if (auth === null) throw new AuthError("unsigned request; set CUE_CLIENT and CUE_KEY_FILE", null);
      const known = keys.get(auth.client);
      if (!known) throw new AuthError(`unknown client ${auth.client}`, auth.client);
      if (Math.abs(now - auth.ts) > skewMs) throw new AuthError(`request timestamp is more than ${config.auth.clockSkewSec}s from the daemon's clock`, auth.client);
      if (!verifySignature({ publicKey: known.key, method, auth, args })) throw new AuthError("bad signature", auth.client);
      if (!known.config.verbs.includes(method)) throw new AuthError(`client ${auth.client} may not call ${method}`, auth.client);
      // Nonces live past the accepted window on both sides of the timestamp.
      if (!store.useNonce({ client: auth.client, nonce: auth.nonce, expiresAt: auth.ts + 2 * skewMs, now })) {
        throw new AuthError("replayed request", auth.client);
      }
      return { caller: { kind: "client", name: auth.client, config: known.config }, args };
    },
  };
}
