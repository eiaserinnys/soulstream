/**
 * observe_node_services(§5) 검증.
 *
 * 고정 GET 4종만 나가는지, 입력 검증, 로그 상한, redirect 금지, bearer가 반환·로그에
 * 새지 않는지, 미설정이면 이 도구만 NOT_CONFIGURED인지 확인한다.
 * 실제 Haniel(9300)이나 운영 토큰 파일은 쓰지 않는다.
 */
import { describe, expect, it, vi } from "vitest";

import {
  NODE_SERVICES_OBSERVATION_NOT_CONFIGURED,
  observeNodeServices,
} from "../../src/mcp/tools/node_services_observation.js";
import type { McpRuntime, NodeServicesObservationConfig } from "../../src/mcp/runtime.js";

const BASE_URL = "http://127.0.0.1:9399";
const TOKEN = "haniel-fake-token-0001";
const TOKEN_FILE = "/nonexistent/fake-haniel-token";

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function fakeHaniel(options: { services?: Record<string, unknown>; failPath?: string; status?: number } = {}) {
  const calls: RecordedCall[] = [];
  const services = options.services ?? {
    alpha: { state: "running", uptime: 12, restart_count: 0 },
    beta: { state: "stopped", uptime: 0, restart_count: 1 },
  };
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const path = url.slice(BASE_URL.length);
    if (options.failPath && path.startsWith(options.failPath)) {
      return new Response("boom", { status: options.status ?? 500 });
    }
    if (path === "/api/status") {
      return Response.json({ state: "ok", node_id: "test-node" });
    }
    if (path === "/api/services") {
      // Haniel은 status["services"] map을 그대로 반환한다.
      return Response.json(services);
    }
    if (path === "/api/orch/pending") {
      return Response.json({ deploys: [{ service: "alpha", target_head: "abc" }] });
    }
    const logs = path.match(/^\/api\/services\/([^/]+)\/logs\?lines=(\d+)$/);
    if (logs) {
      return Response.json({
        service: decodeURIComponent(logs[1] ?? ""),
        lines: Array.from({ length: 10 }, (_unused, index) => `line-${index + 1}`),
      });
    }
    return new Response("not found", { status: 404 });
  });
  return { fetchImpl, calls };
}

function runtimeWith(
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  overrides: Partial<NodeServicesObservationConfig> = {},
): Pick<McpRuntime, "nodeServicesObservation"> {
  return {
    nodeServicesObservation: {
      baseUrl: BASE_URL,
      tokenFile: TOKEN_FILE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readFileImpl: async () => `${TOKEN}\n`,
      ...overrides,
    },
  };
}

describe("observe_node_services configuration", () => {
  it("returns NOT_CONFIGURED from this tool only when env is missing", async () => {
    for (const observation of [
      undefined,
      { baseUrl: "", tokenFile: TOKEN_FILE },
      { baseUrl: BASE_URL, tokenFile: "" },
    ]) {
      const fetchImpl = vi.fn();
      const result = await observeNodeServices(
        { nodeServicesObservation: observation } as unknown as Pick<McpRuntime, "nodeServicesObservation">,
        {},
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: NODE_SERVICES_OBSERVATION_NOT_CONFIGURED });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });
});

describe("observe_node_services fixed GET client", () => {
  it("defaults to status and services only", async () => {
    const { fetchImpl, calls } = fakeHaniel();
    const result = await observeNodeServices(runtimeWith(fetchImpl), {});
    expect(result.isError).toBeUndefined();
    expect(calls.map((call) => call.url)).toEqual([
      `${BASE_URL}/api/status`,
      `${BASE_URL}/api/services`,
    ]);
    for (const call of calls) {
      expect(call.init.method).toBe("GET");
      expect(call.init.redirect).toBe("error");
      expect(call.init.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    }
    expect(result.structuredContent).toMatchObject({
      status: { state: "ok" },
      services: { alpha: { state: "running" } },
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("requires service for logs and validates lines before any fetch", async () => {
    const { fetchImpl, calls } = fakeHaniel();
    const missingService = await observeNodeServices(runtimeWith(fetchImpl), { include_logs: true });
    expect(missingService.isError).toBe(true);
    expect(missingService.structuredContent).toMatchObject({
      code: "NODE_SERVICES_OBSERVATION_INVALID_INPUT",
    });

    const tooMany = await observeNodeServices(runtimeWith(fetchImpl), {
      service: "alpha",
      include_logs: true,
      lines: 201,
    });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.structuredContent).toMatchObject({
      code: "NODE_SERVICES_OBSERVATION_INVALID_INPUT",
    });

    const zero = await observeNodeServices(runtimeWith(fetchImpl), {
      service: "alpha",
      include_logs: true,
      lines: 0,
    });
    expect(zero.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("rejects unknown services after listing services", async () => {
    const { fetchImpl, calls } = fakeHaniel();
    const result = await observeNodeServices(runtimeWith(fetchImpl), {
      service: "ghost",
      include_logs: true,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: "NODE_SERVICES_OBSERVATION_INVALID_SERVICE",
      details: { services: ["alpha", "beta"] },
    });
    expect(calls.map((call) => call.url)).toEqual([
      `${BASE_URL}/api/status`,
      `${BASE_URL}/api/services`,
    ]);
  });

  it("requests the exact lines count and truncates to the tail", async () => {
    const { fetchImpl, calls } = fakeHaniel();
    const result = await observeNodeServices(runtimeWith(fetchImpl), {
      service: "alpha",
      include_logs: true,
      lines: 3,
    });
    expect(calls[2]?.url).toBe(`${BASE_URL}/api/services/alpha/logs?lines=3`);
    expect(result.structuredContent).toMatchObject({
      logs: { service: "alpha", lines: ["line-8", "line-9", "line-10"] },
    });
  });

  it("keeps the service name inside one encoded path segment", async () => {
    const { fetchImpl, calls } = fakeHaniel({
      services: { "weird/name": { state: "running" } },
    });
    const result = await observeNodeServices(runtimeWith(fetchImpl), {
      service: "weird/name",
      include_logs: true,
    });
    expect(result.isError).toBeUndefined();
    expect(calls[2]?.url).toBe(`${BASE_URL}/api/services/weird%2Fname/logs?lines=200`);
  });

  it("fetches pending only when asked and normalizes a trailing slash", async () => {
    const { fetchImpl, calls } = fakeHaniel();
    const result = await observeNodeServices(
      runtimeWith(fetchImpl, { baseUrl: `${BASE_URL}/` }),
      { include_pending: true },
    );
    expect(result.isError).toBeUndefined();
    expect(calls.map((call) => call.url)).toEqual([
      `${BASE_URL}/api/status`,
      `${BASE_URL}/api/services`,
      `${BASE_URL}/api/orch/pending`,
    ]);
    expect(result.structuredContent).toMatchObject({ pending: { deploys: [{ service: "alpha" }] } });
  });
});

describe("observe_node_services failure handling", () => {
  it("reports FAILED for non-ok responses without leaking the bearer", async () => {
    const { fetchImpl } = fakeHaniel({ failPath: "/api/services", status: 502 });
    const result = await observeNodeServices(runtimeWith(fetchImpl), {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "NODE_SERVICES_OBSERVATION_FAILED" });
    expect(String(result.structuredContent?.error)).toContain("502");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("reports FAILED when the token file cannot be read or is empty", async () => {
    const { fetchImpl } = fakeHaniel();
    const unreadable = await observeNodeServices(
      runtimeWith(fetchImpl, { readFileImpl: async () => { throw new Error("ENOENT"); } }),
      {},
    );
    expect(unreadable.isError).toBe(true);
    expect(unreadable.structuredContent).toMatchObject({ code: "NODE_SERVICES_OBSERVATION_FAILED" });

    const empty = await observeNodeServices(
      runtimeWith(fetchImpl, { readFileImpl: async () => "   \n" }),
      {},
    );
    expect(empty.isError).toBe(true);
    expect(empty.structuredContent).toMatchObject({ code: "NODE_SERVICES_OBSERVATION_FAILED" });
  });

  it("rejects invalid base urls before fetching", async () => {
    const { fetchImpl, calls } = fakeHaniel();
    for (const baseUrl of ["not-a-url", "ftp://127.0.0.1:9399"]) {
      const result = await observeNodeServices(runtimeWith(fetchImpl, { baseUrl }), {});
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: "NODE_SERVICES_OBSERVATION_FAILED" });
    }
    expect(calls).toHaveLength(0);
  });
});
