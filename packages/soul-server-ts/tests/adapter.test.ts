import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WSServerWebSocket } from "ws";
import pino from "pino";
import type { AddressInfo } from "node:net";

import { UpstreamAdapter, isConnectionError } from "../src/upstream/adapter.js";

interface MockOrch {
  port: number;
  url: string;
  server: WebSocketServer;
  receivedMessages: unknown[];
  sockets: WSServerWebSocket[];
  expectedAuthHeader?: string;
}

async function startMockOrch(opts: { authToken?: string } = {}): Promise<MockOrch> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const port = (wss.address() as AddressInfo).port;
  const url = `ws://127.0.0.1:${port}/ws/node`;
  const received: unknown[] = [];
  const sockets: WSServerWebSocket[] = [];

  wss.on("connection", (socket, req) => {
    // Bearer auth 확인 (orch ws_handler.py L52-62 등가)
    if (opts.authToken) {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${opts.authToken}`) {
        socket.close(4401, "auth required");
        return;
      }
    }
    sockets.push(socket);
    socket.on("message", (raw) => {
      const text = Buffer.isBuffer(raw) ? raw.toString("utf-8") : String(raw);
      try {
        received.push(JSON.parse(text));
      } catch {
        received.push(text);
      }
    });
  });

  return { port, url, server: wss, receivedMessages: received, sockets };
}

async function stopMockOrch(orch: MockOrch): Promise<void> {
  for (const sock of orch.sockets) sock.close();
  await new Promise<void>((r) => orch.server.close(() => r()));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

const silentLogger = pino({ level: "silent" });

describe("UpstreamAdapter", () => {
  let orch: MockOrch;

  beforeEach(async () => {
    orch = await startMockOrch();
  });

  afterEach(async () => {
    await stopMockOrch(orch);
  });

  it("연결 후 첫 메시지로 node_register payload를 발행한다", async () => {
    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "",
        userName: "",
        isProduction: false,
      },
      silentLogger,
    );

    void adapter.run();
    await waitFor(() => orch.receivedMessages.length >= 1);

    const first = orch.receivedMessages[0] as Record<string, unknown>;
    expect(first.type).toBe("node_register");
    expect(first.node_id).toBe("eias-shopping-ts");
    expect(first.supported_backends).toEqual(["codex"]);
    expect(first.capabilities).toEqual({ max_concurrent: 0 });
    // Phase B-2 R6: 임시 codex-default agent 광고 (B-3에서 agent_registry yaml 정본 교체).
    expect(first.agents).toEqual([
      { id: "codex-default", name: "Codex Default", backend: "codex" },
    ]);

    await adapter.shutdown();
  });

  it("health_check 명령을 받으면 health_status로 응답한다", async () => {
    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "",
        userName: "",
        isProduction: false,
      },
      silentLogger,
    );

    void adapter.run();
    await waitFor(() => orch.sockets.length >= 1 && orch.receivedMessages.length >= 1);

    // orch가 health_check를 보냄
    orch.sockets[0]!.send(JSON.stringify({ type: "health_check", requestId: "hc-1" }));

    await waitFor(() => orch.receivedMessages.length >= 2);

    const reply = orch.receivedMessages[1] as Record<string, unknown>;
    expect(reply.type).toBe("health_status");
    expect(reply.node_id).toBe("eias-shopping-ts");
    expect(reply.requestId).toBe("hc-1");
    expect(reply.runners).toEqual({ max_concurrent: 0, active: 0 });

    await adapter.shutdown();
  });

  it("미구현 명령에 error fallback 응답", async () => {
    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "",
        userName: "",
        isProduction: false,
      },
      silentLogger,
    );
    void adapter.run();
    await waitFor(() => orch.sockets.length >= 1 && orch.receivedMessages.length >= 1);

    orch.sockets[0]!.send(JSON.stringify({ type: "create_session", requestId: "cs-1" }));
    await waitFor(() => orch.receivedMessages.length >= 2);

    const reply = orch.receivedMessages[1] as Record<string, unknown>;
    expect(reply.type).toBe("error");
    expect(reply.command_type).toBe("create_session");
    expect(reply.requestId).toBe("cs-1");
    expect(reply.message).toContain("Not implemented in soul-server-ts B-1");

    await adapter.shutdown();
  });

  it("AUTH_BEARER_TOKEN 헤더로 Bearer 인증을 보낸다", async () => {
    await stopMockOrch(orch);
    orch = await startMockOrch({ authToken: "test-token" });

    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "test-token",
        userName: "",
        isProduction: false,
      },
      silentLogger,
    );
    void adapter.run();
    await waitFor(() => orch.receivedMessages.length >= 1);

    expect(orch.receivedMessages.length).toBeGreaterThan(0);
    await adapter.shutdown();
  });

  it("잘못된 AUTH 토큰이면 연결 close → 재연결 시도 (running 종료 후 정리)", async () => {
    await stopMockOrch(orch);
    orch = await startMockOrch({ authToken: "correct-token" });

    const adapter = new UpstreamAdapter(
      {
        url: orch.url,
        nodeId: "eias-shopping-ts",
        host: "127.0.0.1",
        port: 4205,
        authBearerToken: "wrong-token",
        userName: "",
        isProduction: false,
      },
      silentLogger,
    );
    void adapter.run();

    // 잠시 대기 — 토큰 거부로 receivedMessages 0건 유지되어야 함
    await new Promise((r) => setTimeout(r, 200));
    expect(orch.receivedMessages).toHaveLength(0);

    await adapter.shutdown();
  });
});

describe("isConnectionError", () => {
  it("ECONNREFUSED는 연결 오류", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(isConnectionError(err)).toBe(true);
  });

  it("ETIMEDOUT, ENOTFOUND, ECONNRESET, EHOSTUNREACH, ENETUNREACH 모두 연결 오류", () => {
    const codes = ["ETIMEDOUT", "ENOTFOUND", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"];
    for (const code of codes) {
      const err = Object.assign(new Error(`x ${code}`), { code });
      expect(isConnectionError(err), `for ${code}`).toBe(true);
    }
  });

  it("WS handshake 메시지는 연결 오류", () => {
    const err = new Error("Unexpected server response: 401");
    expect(isConnectionError(err)).toBe(true);
  });

  it("일반 TypeError는 연결 오류가 아님", () => {
    expect(isConnectionError(new TypeError("cannot read property foo of undefined"))).toBe(false);
  });

  it("Error 아닌 값은 false", () => {
    expect(isConnectionError("string error")).toBe(false);
    expect(isConnectionError(null)).toBe(false);
    expect(isConnectionError(undefined)).toBe(false);
  });
});
