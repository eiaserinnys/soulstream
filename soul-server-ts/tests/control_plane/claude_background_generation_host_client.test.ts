import { describe, expect, it, vi } from "vitest";

import {
  CLAUDE_BACKGROUND_GENERATION_RETRY_DELAYS_MS,
  ClaudeBackgroundGenerationHostClient,
} from "../../src/control_plane/claude_background_generation_host_client.js";
import {
  ORCH_HOST_REQUEST_TIMEOUT_MS,
  PersistenceHostRequestError,
  type PersistenceHostTransport,
} from "../../src/control_plane/persistence_host_transport.js";

function transportError(operation: string, status?: number): PersistenceHostRequestError {
  return new PersistenceHostRequestError(
    "claude-runtime",
    operation,
    status === undefined
      ? `claude-runtime host ${operation} request failed`
      : `claude-runtime host ${operation} failed: ${status}`,
    status,
  );
}

function clientWith(
  request: ReturnType<typeof vi.fn>,
  retryDelaysMs?: readonly number[],
): ClaudeBackgroundGenerationHostClient {
  return new ClaudeBackgroundGenerationHostClient(
    { request } as unknown as PersistenceHostTransport,
    retryDelaysMs,
  );
}

describe("ClaudeBackgroundGenerationHostClient retry policy", () => {
  it("retries a resolve read after two 502 responses and returns the third result", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(transportError("resolve_background_generation", 502))
      .mockRejectedValueOnce(transportError("resolve_background_generation", 502))
      .mockResolvedValueOnce({ status: "absent" });
    const client = clientWith(request, [0, 0]);

    await expect(client.resolve("node-a", "session-a", "sdk-a", "task-a"))
      .resolves.toEqual({ status: "absent" });

    expect(request).toHaveBeenCalledTimes(3);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "claude-runtime",
      "resolve_background_generation",
      ["node-a", "session-a", "sdk-a", "task-a"],
      expect.objectContaining({ timeoutMs: ORCH_HOST_REQUEST_TIMEOUT_MS }),
    );
  });

  it("retries a resolve read after a connection failure that carries no status", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(transportError("resolve_background_generation"))
      .mockResolvedValueOnce({ status: "absent" });
    const client = clientWith(request, [0]);

    await expect(client.resolve("node-a", "session-a", "sdk-a", "task-a"))
      .resolves.toEqual({ status: "absent" });

    expect(request).toHaveBeenCalledTimes(2);
  });

  it("retries an observe write after a 502 and keeps the two second per-attempt timeout", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(transportError("observe_background_generation", 502))
      .mockResolvedValueOnce({ status: "running" });
    const client = clientWith(request, [0]);
    const params = {
      sourceNode: "node-a",
      sessionId: "session-a",
      taskId: "task-a",
      sdkSessionId: "sdk-a",
      initiatingToolUseId: "toolu-a",
      generationKey: "generation-a",
      relationKey: "relation-a",
      completionId: "completion-a",
      status: "running" as const,
    };

    await expect(client.observe(params)).resolves.toEqual({ status: "running" });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "claude-runtime",
      "observe_background_generation",
      [params],
      expect.objectContaining({ timeoutMs: 2_000 }),
    );
  });

  it("retries a terminalize write after a 502", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(transportError("terminalize_background_generation", 502))
      .mockResolvedValueOnce({ accepted: true });
    const client = clientWith(request, [0]);
    const params = {
      sourceNode: "node-a",
      sessionId: "session-a",
      taskId: "task-a",
      sdkSessionId: "sdk-a",
      initiatingToolUseId: "toolu-a",
      generationKey: "generation-a",
      relationKey: "relation-a",
      completionId: "completion-a",
      status: "completed" as const,
      closeReason: "sdk_completed",
      terminalRevision: "1785081600000",
    } as never;

    await expect(client.terminalize(params)).resolves.toEqual({ accepted: true });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      1,
      "claude-runtime",
      "terminalize_background_generation",
      [params],
      expect.objectContaining({ timeoutMs: ORCH_HOST_REQUEST_TIMEOUT_MS }),
    );
  });

  it("does not retry a terminalize owner conflict and rethrows its status and code", async () => {
    const failure = new PersistenceHostRequestError(
      "claude-runtime",
      "terminalize_background_generation",
      "claude-runtime host terminalize_background_generation failed: Claude background execution owner conflict: generation-a stored=registration-a/command-a requested=registration-b/command-b",
      409,
      { code: "CLAUDE_BACKGROUND_EXECUTION_OWNER_CONFLICT" },
    );
    const request = vi.fn().mockRejectedValue(failure);
    const client = clientWith(request, [1, 1]);
    const params = {
      sourceNode: "node-a",
      sessionId: "session-a",
      taskId: "task-a",
      sdkSessionId: "sdk-a",
      initiatingToolUseId: "toolu-a",
      generationKey: "generation-a",
      relationKey: "relation-a",
      completionId: "completion-a",
      runnerRegistrationId: "registration-b",
      executionCommandId: "command-b",
      status: "completed" as const,
      closeReason: "sdk_completed",
      terminalRevision: "1785081600000",
    } as never;

    const rejection = client.terminalize(params);
    await expect(rejection).rejects.toBe(failure);
    await expect(rejection).rejects.toMatchObject({
      status: 409,
      code: "CLAUDE_BACKGROUND_EXECUTION_OWNER_CONFLICT",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-retryable 401 and rethrows it unchanged", async () => {
    const failure = transportError("resolve_background_generation", 401);
    const request = vi.fn().mockRejectedValue(failure);
    const client = clientWith(request, [1, 1]);

    await expect(client.resolve("node-a", "session-a", "sdk-a", "task-a"))
      .rejects.toBe(failure);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rethrows the last error once every injected delay is spent", async () => {
    const first = transportError("resolve_background_generation", 502);
    const second = transportError("resolve_background_generation", 503);
    const last = transportError("resolve_background_generation", 504);
    const request = vi.fn()
      .mockRejectedValueOnce(first)
      .mockRejectedValueOnce(second)
      .mockRejectedValueOnce(last);
    const client = clientWith(request, [1, 1]);

    await expect(client.resolve("node-a", "session-a", "sdk-a", "task-a"))
      .rejects.toBe(last);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("keeps a default retry window that covers the 66 second core restart", () => {
    expect(CLAUDE_BACKGROUND_GENERATION_RETRY_DELAYS_MS).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 12_000, 15_000, 15_000, 15_000, 15_000,
    ]);
    const totalMs = CLAUDE_BACKGROUND_GENERATION_RETRY_DELAYS_MS
      .reduce((sum, delay) => sum + delay, 0);
    expect(totalMs).toBe(87_500);
    expect(totalMs).toBeGreaterThan(66_000);
    expect(totalMs).toBeGreaterThanOrEqual(80_000);
    expect(totalMs).toBeLessThanOrEqual(120_000);
  });
});
