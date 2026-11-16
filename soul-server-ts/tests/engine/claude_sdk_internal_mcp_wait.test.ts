import { createServer, type AddressInfo, type Server } from "node:net";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudeSdkClient } from "../../src/engine/claude_adapter.js";
import type { ClaudeRunOptions } from "../../src/engine/claude_adapter.js";
import {
  abortSignal,
  collect,
  makeHarness,
  runOptions,
} from "./claude_sdk_persistent_test_harness.js";

const silentLogger = pino({ level: "silent" });

/** soulstream 프로필 서버가 노드 내부 MCP 리스너로 바뀐 run 옵션. */
function internalMcpRunOptions(prompt: string, internalMcpUrl: string): ClaudeRunOptions {
  return {
    ...runOptions(prompt),
    resolvedMcpServers: [{
      type: "streamable_http",
      name: "soulstream",
      url: "http://soulstream.invalid/mcp",
    }],
    internalMcpUrl,
  };
}

async function reserveClosedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

const openServers: Server[] = [];

function openListener(port: number): Promise<Server> {
  const server = createServer((socket) => socket.destroy());
  openServers.push(server);
  return new Promise<Server>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  })));
});

describe("ClaudeSdkClient internal MCP listener readiness", () => {
  it("waits for a late internal MCP listener before creating the persistent Query", async () => {
    const port = await reserveClosedPort();
    const logger = pino({ level: "silent" });
    const info = vi.spyOn(logger, "info");
    const listenerOpenedAt = new Promise<number>((resolve) => {
      setTimeout(() => {
        void openListener(port).then(() => resolve(Date.now()));
      }, 150);
    });

    const harness = makeHarness();
    const queriedAt: number[] = [];
    const client = new ClaudeSdkClient({
      query: (params) => {
        queriedAt.push(Date.now());
        return harness.queryFn(params);
      },
      internalMcpReadyTimeoutMs: 5_000,
      internalMcpReadyIntervalMs: 25,
    }, logger);
    const turn = collect(client.runPersistent(
      internalMcpRunOptions("late listener", `http://127.0.0.1:${port}/mcp`),
      abortSignal(),
    ));

    await vi.waitFor(() => expect(queriedAt).toHaveLength(1), { timeout: 5_000 });
    expect(queriedAt[0]).toBeGreaterThanOrEqual(await listenerOpenedAt);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ waitedMs: expect.any(Number) }),
      expect.stringContaining("internal MCP"),
    );

    await harness.nextInput();
    harness.end();
    await turn;
    await client.close();
  });

  it("creates the Query without delay when the internal MCP listener is already open", async () => {
    const port = await reserveClosedPort();
    await openListener(port);

    const harness = makeHarness();
    const client = new ClaudeSdkClient({
      query: harness.queryFn,
      internalMcpReadyTimeoutMs: 5_000,
      // 이미 열린 리스너를 한 번이라도 기다리면 이 간격만큼 늦어진다.
      internalMcpReadyIntervalMs: 5_000,
    }, silentLogger);
    const startedAt = Date.now();
    const turn = collect(client.runPersistent(
      internalMcpRunOptions("open listener", `http://127.0.0.1:${port}/mcp`),
      abortSignal(),
    ));

    await vi.waitFor(() => expect(harness.captured).toHaveLength(1), { timeout: 1_000 });
    expect(Date.now() - startedAt).toBeLessThan(1_000);

    await harness.nextInput();
    harness.end();
    await turn;
    await client.close();
  });

  it("proceeds with the Query and a warning when the listener never opens before the timeout", async () => {
    const port = await reserveClosedPort();
    const logger = pino({ level: "silent" });
    const warn = vi.spyOn(logger, "warn");
    const harness = makeHarness();
    const client = new ClaudeSdkClient({
      query: harness.queryFn,
      internalMcpReadyTimeoutMs: 150,
      internalMcpReadyIntervalMs: 25,
    }, logger);
    const startedAt = Date.now();
    const turn = collect(client.runPersistent(
      internalMcpRunOptions("closed listener", `http://127.0.0.1:${port}/mcp`),
      abortSignal(),
    ));

    await vi.waitFor(() => expect(harness.captured).toHaveLength(1), { timeout: 2_000 });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 150 }),
      expect.stringContaining("internal MCP"),
    );

    await harness.nextInput();
    harness.end();
    await turn;
    await client.close();
  });
});
