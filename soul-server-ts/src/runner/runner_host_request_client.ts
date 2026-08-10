import { randomUUID } from "node:crypto";

import {
  hostCallAppliedControlFrame,
  runnerRequestFrame,
  type RunnerControlFrame,
} from "./frame_protocol.js";
import type { RunnerIpcConnection } from "./runner_ipc_connection.js";

export type RunnerHostService =
  | "session_store"
  | "claude_runtime"
  | "detached_event"
  | "snapshot";

export interface RunnerHostRequestOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  attempts?: number;
  retryDelayMs?: number;
}

/**
 * Runner-side bounded proxy for host-owned state. Retries retain the same
 * correlation id so the host can return a cached response after reconnect
 * instead of applying a non-idempotent operation twice.
 */
export class RunnerHostRequestClient {
  constructor(
    private readonly getConnection: () => RunnerIpcConnection | undefined,
    private readonly delay: (ms: number, signal?: AbortSignal) => Promise<void> = abortableDelay,
  ) {}

  async call(
    service: RunnerHostService,
    operation: string,
    args: unknown[],
    options: RunnerHostRequestOptions,
  ): Promise<unknown> {
    const correlationId = `host:${randomUUID()}`;
    const attempts = options.attempts ?? 3;
    const retryDelayMs = options.retryDelayMs ?? 100;
    if (!Number.isInteger(attempts) || attempts <= 0) {
      throw new Error("Runner host request attempts must be positive");
    }
    const frame = runnerRequestFrame(correlationId, {
      kind: "host_call",
      service,
      operation,
      args,
    }, { timeoutMs: options.timeoutMs });
    const lifetime = createRequestLifetime(options.signal, options.timeoutMs);
    const deadline = Date.now() + options.timeoutMs;
    let lastError: Error | undefined;
    try {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (lifetime.signal.aborted) throw abortReason(lifetime.signal);
        const connection = this.getConnection();
        if (!connection) {
          lastError = new Error("Runner host connection unavailable");
        } else {
          try {
            const response = await connection.request(frame, {
              signal: lifetime.signal,
              timeoutMs: Math.max(1, deadline - Date.now()),
            });
            const data = readResponse(response);
            await connection.send(hostCallAppliedControlFrame(correlationId));
            return data;
          } catch (error) {
            if (lifetime.signal.aborted) throw abortReason(lifetime.signal);
            lastError = asError(error);
          }
        }
        if (attempt < attempts) await this.delay(retryDelayMs, lifetime.signal);
      }
      throw new Error(
        `Runner host request ${service}.${operation} failed after ${attempts} attempts`,
        { cause: lastError },
      );
    } finally {
      lifetime.cleanup();
    }
  }
}

function readResponse(frame: RunnerControlFrame): unknown {
  if (frame.kind !== "response") throw new Error("Runner host request received wrong response");
  if (frame.result.status === "ok") return frame.result.data;
  throw new Error(
    `Runner host request failed (${frame.result.error.code}): ${frame.result.error.message}`,
  );
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", rejectOnAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    const rejectOnAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", rejectOnAbort);
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", rejectOnAbort, { once: true });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(signal.reason ? String(signal.reason) : "Runner host request aborted");
}

function createRequestLifetime(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup(): void;
} {
  const controller = new AbortController();
  const relayParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) relayParentAbort();
  else parent?.addEventListener("abort", relayParentAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error(`Runner host request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", relayParentAbort);
    },
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
