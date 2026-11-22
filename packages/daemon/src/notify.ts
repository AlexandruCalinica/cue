import type { JobResult, NotifierConfig } from "@cue/core";
import type { Store } from "@cue/store";
import type { HookRunner } from "./hooks.js";

/** Whether a notifier subscribed to this outcome. */
export function wants(notifier: Pick<NotifierConfig, "on">, result: Pick<JobResult, "status" | "flags">): boolean {
  return notifier.on.some((on) => on === "terminal" || on === result.status || (on === "flagged" && result.flags.length > 0));
}

/** What a webhook receives as its JSON body. */
export interface NotifyPayload {
  readonly event: "job.finished";
  readonly result: JobResult;
}

export interface NotifierDeps {
  readonly notifiers: readonly NotifierConfig[];
  readonly hooks: HookRunner;
  readonly store: Store;
  readonly fetch?: typeof fetch;
  /** Delay before the single webhook retry. Default 1000 ms. */
  readonly retryDelayMs?: number;
}

export interface NotifyInput {
  readonly result: JobResult;
  readonly jobDir: string;
  readonly resultPath: string;
}

/** Delivers notifications for one finished job. Never rejects; failures become `notify-failed` events. */
export type Notify = (input: NotifyInput) => Promise<void>;

const describe = (n: NotifierConfig) => (n.kind === "webhook" ? `webhook ${new URL(n.url).host}` : `command ${n.run[0] ?? "?"}`);

/**
 * Best-effort, at-most-once delivery after the job is recorded as finished, so a
 * notifier can never change a job's outcome. A daemon crash between finishing
 * and notifying drops the notification.
 */
export function createNotifier(deps: NotifierDeps): Notify {
  const doFetch = deps.fetch ?? fetch;
  const retryDelayMs = deps.retryDelayMs ?? 1000;

  async function postOnce(n: Extract<NotifierConfig, { kind: "webhook" }>, body: string): Promise<{ ok: boolean; retry: boolean; error: string }> {
    try {
      const res = await doFetch(n.url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "cue", ...n.headers },
        body,
        signal: AbortSignal.timeout(n.timeoutSec * 1000),
      });
      await res.body?.cancel();
      if (res.ok) return { ok: true, retry: false, error: "" };
      return { ok: false, retry: res.status >= 500 || res.status === 429, error: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, retry: true, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function deliver(n: NotifierConfig, input: NotifyInput): Promise<string | null> {
    if (n.kind === "webhook") {
      const body = JSON.stringify({ event: "job.finished", result: input.result } satisfies NotifyPayload);
      let r = await postOnce(n, body);
      if (!r.ok && r.retry) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        r = await postOnce(n, body);
      }
      return r.ok ? null : r.error;
    }
    const outcome = await deps.hooks.run({
      hook: { run: n.run, timeoutSec: n.timeoutSec, required: false },
      context: { point: "notify", jobId: input.result.id, jobDir: input.jobDir, workdir: input.jobDir, resultPath: input.resultPath },
    });
    if (outcome.kind === "ok") return null;
    return outcome.kind === "timeout" ? "timed out" : `exited ${outcome.exitCode ?? "?"}: ${outcome.stderrTail.trim()}`;
  }

  return async (input) => {
    const selected = deps.notifiers.filter((n) => wants(n, input.result));
    await Promise.all(
      selected.map(async (n) => {
        let error: string | null;
        try {
          error = await deliver(n, input);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        try {
          deps.store.appendEvent({
            jobId: input.result.id,
            type: error === null ? "notified" : "notify-failed",
            data: error === null ? { to: describe(n) } : { to: describe(n), error },
          });
        } catch {
          // The store may already be closed during shutdown; delivery stays best-effort.
        }
      }),
    );
  };
}
