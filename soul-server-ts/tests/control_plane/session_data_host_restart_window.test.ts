import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SessionDataHostClient,
  SessionDataHostError,
} from "../../src/control_plane/session_data_host_client.js";
import {
  ISOLATION_POLICY_UNAVAILABLE,
  resolveExecutionSecurityDecision,
  type ExecutionSecurityPolicyPorts,
} from "../../src/security/session_execution_policy.js";

interface LogEntry {
  level: "warn" | "info";
  fields: Record<string, unknown>;
  message: string;
}

/** Captures the client's own lines separately from the transport's request logs. */
function recordingLogger(): { logger: Logger; logs: LogEntry[] } {
  const logs: LogEntry[] = [];
  const record = (level: "warn" | "info") => (fields: unknown, message?: string) => {
    logs.push({
      level,
      fields: (fields ?? {}) as Record<string, unknown>,
      message: message ?? "",
    });
  };
  const logger = {
    warn: record("warn"),
    info: record("info"),
    error: record("warn"),
    debug: () => undefined,
  } as unknown as Logger;
  return { logger, logs };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CHAIN = {
  root: {
    session_id: "s1",
    caller_session_id: null,
    model_preset: "claude-opus",
    model: null,
    agent_id: "roselin",
  },
  ancestors: [],
};

function clientFor(logger: Logger): SessionDataHostClient {
  return new SessionDataHostClient({
    orch: { baseUrl: "http://orchestrator.test", headers: {} },
    logger,
  });
}

function policyPorts(client: SessionDataHostClient): ExecutionSecurityPolicyPorts {
  return {
    platform: "linux",
    readSession: (sessionId) => client.getSessionCallerChain(sessionId),
    readNodePreset: () => null,
    isTrustedPreset: (presetId) => presetId === "claude-opus",
  };
}

/** Drives the fake clock in one-second steps until the promise settles. */
async function driveUntilSettled(promise: Promise<unknown>, seconds: number): Promise<void> {
  let settled = false;
  void promise.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  for (let second = 0; second < seconds && !settled; second += 1) {
    await vi.advanceTimersByTimeAsync(1_000);
  }
  expect(settled).toBe(true);
}

function retryLogs(logs: LogEntry[]): LogEntry[] {
  return logs.filter(
    entry => entry.level === "warn" && entry.message.includes("retrying"),
  );
}

function recoveredLogs(logs: LogEntry[]): LogEntry[] {
  return logs.filter(
    entry => entry.level === "info" && entry.message.includes("recovered"),
  );
}

describe("isolation policy read across an orchestrator restart", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the session start when the host answers 502s for ~20s", async () => {
    vi.useFakeTimers();
    const { logger, logs } = recordingLogger();
    const startedAt = Date.now();
    const fetchMock = vi.fn(async () => {
      if (Date.now() - startedAt < 20_000) {
        return jsonResponse(
          { detail: { error: { code: "ORCH_RESTARTING", message: "upstream connect error" } } },
          502,
        );
      }
      return jsonResponse(CHAIN);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = clientFor(logger);

    const decision = resolveExecutionSecurityDecision("s1", "claude-opus", policyPorts(client));
    await driveUntilSettled(decision, 40);

    await expect(decision).resolves.toMatchObject({ tier: "full", reason: "trusted" });
    // Attempts at 0, 250, 1250, 3250, 7250, 11250, 15250, 19250ms answer 502;
    // the widened delay then reaches the host at 23250ms.
    expect(fetchMock).toHaveBeenCalledTimes(9);

    const retries = retryLogs(logs);
    expect(retries.map(entry => entry.fields.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(retries.every(entry => entry.fields.read === "caller_chain")).toBe(true);
    expect(retries.map(entry => entry.fields.failure)).toEqual(Array(8).fill("http-502"));
    expect(retries.map(entry => entry.fields.retryInMs))
      .toEqual([250, 1_000, 2_000, 4_000, 4_000, 4_000, 4_000, 4_000]);
    expect(retries.at(-1)?.fields.elapsedMs).toBe(19_250);

    const recovered = recoveredLogs(logs);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.fields)
      .toMatchObject({ read: "caller_chain", attempt: 9, elapsedMs: 23_250 });
  });

  it("keeps the evicted-session read when the host answers 502s for ~20s", async () => {
    vi.useFakeTimers();
    const { logger, logs } = recordingLogger();
    const startedAt = Date.now();
    const fetchMock = vi.fn(async () => {
      if (Date.now() - startedAt < 20_000) {
        return jsonResponse(
          { detail: { error: { code: "ORCH_RESTARTING", message: "upstream connect error" } } },
          502,
        );
      }
      return jsonResponse({ session_id: "s1", status: "running" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = clientFor(logger);

    const read = client.getSession("s1", { restartWindow: true });
    await driveUntilSettled(read, 40);

    await expect(read).resolves.toEqual({ session_id: "s1", status: "running" });
    expect(fetchMock).toHaveBeenCalledTimes(9);
    const retries = retryLogs(logs);
    expect(retries.map(entry => entry.fields.read))
      .toEqual(Array(8).fill("evicted_session"));
    expect(retries.map(entry => entry.fields.retryInMs))
      .toEqual([250, 1_000, 2_000, 4_000, 4_000, 4_000, 4_000, 4_000]);
    expect(recoveredLogs(logs)[0]?.fields).toMatchObject({
      read: "evicted_session",
      attempt: 9,
      elapsedMs: 23_250,
    });
  });

  it("keeps a session-start read through a restart longer than 25s", async () => {
    vi.useFakeTimers();
    const { logger, logs } = recordingLogger();
    const startedAt = Date.now();
    const fetchMock = vi.fn(async () => {
      if (Date.now() - startedAt < 60_000) {
        throw new TypeError("fetch failed", {
          cause: Object.assign(
            new Error("connect ECONNREFUSED 127.0.0.1:3105"),
            { code: "ECONNREFUSED" },
          ),
        });
      }
      return jsonResponse(CHAIN);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = clientFor(logger);

    const request = client.getSessionCallerChain("s1");
    await driveUntilSettled(request, 90);

    await expect(request).resolves.toEqual(CHAIN);
    // Attempts at 0, 250, 1250, 3250, 7250, 11250, 15250, 19250, 23250ms,
    // then every 4s; the one at 59250ms still sees the refusal and the host
    // answers the attempt at 63250ms.
    expect(fetchMock).toHaveBeenCalledTimes(19);
    expect(retryLogs(logs).at(-1)?.fields).toMatchObject({
      attempt: 18,
      failure: "network-ECONNREFUSED",
      elapsedMs: 59_250,
      retryInMs: 4_000,
    });
    expect(recoveredLogs(logs)[0]?.fields).toMatchObject({ attempt: 19, elapsedMs: 63_250 });
  });

  it("refuses the session start at the 90s budget when the restart outlasts it", async () => {
    vi.useFakeTimers();
    const { logger, logs } = recordingLogger();
    const startedAt = Date.now();
    const attemptTimes: number[] = [];
    const fetchMock = vi.fn(async () => {
      attemptTimes.push(Date.now() - startedAt);
      return jsonResponse(
        { detail: { error: { code: "ORCH_RESTARTING", message: "down" } } },
        502,
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = clientFor(logger);

    const decision = resolveExecutionSecurityDecision("s1", "claude-opus", policyPorts(client));
    await driveUntilSettled(decision, 100);

    const failure = await decision.catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "IsolationPolicyUnavailableError",
      code: ISOLATION_POLICY_UNAVAILABLE,
    });
    expect((failure as { cause?: unknown }).cause).toBeInstanceOf(SessionDataHostError);
    expect(fetchMock).toHaveBeenCalledTimes(26);
    // The last attempt starts inside the budget with its timeout reduced to
    // the time that remains (1ms here), so the call ends at ~90s, not later.
    expect(attemptTimes.at(-1)).toBe(89_999);
    expect(attemptTimes.every(attemptAtMs => attemptAtMs < 90_000)).toBe(true);
    const retries = retryLogs(logs);
    expect(retries.at(-1)?.fields).toMatchObject({
      attempt: 25,
      failure: "http-502",
      elapsedMs: 87_250,
      retryInMs: 2_749,
    });
  });

  it("keeps the three-attempt rule when the host never answers", async () => {
    vi.useFakeTimers();
    const { logger, logs } = recordingLogger();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = clientFor(logger);

    const request = client.getSessionCallerChain("s1");
    await driveUntilSettled(request, 30);

    await expect(request).rejects.toBeInstanceOf(SessionDataHostError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(timeoutSpy.mock.calls.map(([timeoutMs]) => timeoutMs)).toEqual([8_000, 8_000, 8_000]);
    const retries = retryLogs(logs);
    expect(retries.map(entry => entry.fields.failure)).toEqual(["timeout", "timeout"]);
    expect(retries.map(entry => entry.fields.retryInMs)).toEqual([250, 1_000]);
  });

  it("fails immediately on a rejected request", async () => {
    for (const status of [400, 403]) {
      const { logger, logs } = recordingLogger();
      const fetchMock = vi.fn(async () => jsonResponse(
        { detail: { error: { code: "REJECTED", message: "no" } } },
        status,
      ));
      vi.stubGlobal("fetch", fetchMock);
      const client = clientFor(logger);

      await expect(client.getSessionCallerChain("s1"))
        .rejects.toBeInstanceOf(SessionDataHostError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(retryLogs(logs)).toEqual([]);
    }
  });

  it("counts refused and dropped connections as restart-window failures", async () => {
    vi.useFakeTimers();
    const { logger, logs } = recordingLogger();
    const failures: Array<() => unknown> = [
      () => new TypeError("fetch failed", {
        cause: Object.assign(
          new Error("connect ECONNREFUSED 127.0.0.1:3105"),
          { code: "ECONNREFUSED" },
        ),
      }),
      () => new TypeError("fetch failed", {
        cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      }),
    ];
    const fetchMock = vi.fn(async () => {
      const failure = failures.shift();
      if (failure !== undefined) throw failure();
      return jsonResponse(CHAIN);
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = clientFor(logger);

    const request = client.getSessionCallerChain("s1");
    await driveUntilSettled(request, 5);

    await expect(request).resolves.toEqual(CHAIN);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(retryLogs(logs).map(entry => entry.fields.failure))
      .toEqual(["network-ECONNREFUSED", "network-ECONNRESET"]);
    expect(recoveredLogs(logs)[0]?.fields).toMatchObject({ attempt: 3, elapsedMs: 1_250 });
  });

  it("leaves the other host call budgets unchanged", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const { logger } = recordingLogger();
    const client = clientFor(logger);
    const busy = () => jsonResponse(
      { detail: { error: { code: "HOST_BUSY", message: "busy" } } },
      503,
    );

    const turnCritical = vi.fn(async () => busy());
    vi.stubGlobal("fetch", turnCritical);
    await expect(client.getSession("s1")).rejects.toBeInstanceOf(SessionDataHostError);
    expect(turnCritical).toHaveBeenCalledTimes(2);

    const background = vi.fn(async () => busy());
    vi.stubGlobal("fetch", background);
    await expect(client.countTurnSummaries("s1")).rejects.toBeInstanceOf(SessionDataHostError);
    expect(background).toHaveBeenCalledTimes(2);

    const interactive = vi.fn(async () => busy());
    vi.stubGlobal("fetch", interactive);
    await expect(client.listSessionsSummary({ limit: 1, offset: 0 }))
      .rejects.toBeInstanceOf(SessionDataHostError);
    expect(interactive).toHaveBeenCalledTimes(1);

    expect(timeoutSpy.mock.calls.map(([timeoutMs]) => timeoutMs))
      .toEqual([8_000, 8_000, 2_000, 2_000, 5_000]);
  });
});
