/**
 * observe_node_services(§5) 검증.
 *
 * dashboard(status/services/logs)와 orch(pending/nodes)의 고정 GET 다섯 종류만
 * 나가는지, 입력 검증, 로그 상한, redirect 금지, bearer가 반환·로그에 새지 않는지,
 * 한쪽 미설정이면 그쪽만 NOT_CONFIGURED인지 확인한다.
 * orch의 볼트 출처는 가짜 Vault 응답으로 확인하며, 볼트 토큰·bearer·응답 본문이
 * 결과에 새지 않는지도 본다.
 * 실제 Haniel(9300)이나 운영 토큰 파일·Vault는 쓰지 않는다.
 */
import { describe, expect, it, vi } from "vitest";

import {
  NODE_SERVICES_OBSERVATION_NOT_CONFIGURED,
  observeNodeServices,
} from "../../src/mcp/tools/node_services_observation.js";
import type {
  McpRuntime,
  NodeServicesObservationConfig,
  NodeServicesObservationEndpointConfig,
} from "../../src/mcp/runtime.js";

const DASHBOARD_URL = "http://127.0.0.1:9399";
const ORCH_URL = "http://127.0.0.1:9398";
const DASHBOARD_TOKEN = "haniel-dashboard-fake-token-0001";
const ORCH_TOKEN = "haniel-orch-fake-token-0001";
const DASHBOARD_TOKEN_FILE = "/nonexistent/fake-dashboard-token";
const ORCH_TOKEN_FILE = "/nonexistent/fake-orch-token";
const ORCH_VAULT_ENV_FILE = "/nonexistent/fake-vault-env";
const VAULT_URL = "https://vault.eiaserinnys.me";
const VAULT_SECRET_PATH = "/v1/secret/data/shared/haniel";
const VAULT_TOKEN = "vault-fake-token-0001";
const VAULT_BEARER = "vault-fake-bearer-0001";

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function fakeHaniel(options: {
  services?: Record<string, unknown>;
  failPath?: string;
  status?: number;
  vaultUrl?: string;
  vaultResponse?: () => Response;
} = {}) {
  const calls: RecordedCall[] = [];
  const services = options.services ?? {
    alpha: { state: "running", uptime: 12, restart_count: 0 },
    beta: { state: "stopped", uptime: 0, restart_count: 1 },
  };
  const vaultUrl = options.vaultUrl ?? VAULT_URL;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url === `${vaultUrl}${VAULT_SECRET_PATH}`) {
      return options.vaultResponse?.()
        ?? Response.json({ data: { data: { bearer: VAULT_BEARER } } });
    }
    const path = url.startsWith(DASHBOARD_URL)
      ? url.slice(DASHBOARD_URL.length)
      : url.startsWith(ORCH_URL)
        ? url.slice(ORCH_URL.length)
        : undefined;
    if (path === undefined) return new Response("not found", { status: 404 });
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
    if (path === "/api/orch/nodes") {
      return Response.json({ nodes: [{ node_id: "eiaserinnys", state: "ok" }] });
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

interface RuntimeOptions {
  /** null이면 그 side는 설정하지 않는다. 생략하면 기본 fake 주소·토큰 파일을 쓴다. */
  dashboard?: Partial<NodeServicesObservationEndpointConfig> | null;
  orch?: Partial<NodeServicesObservationEndpointConfig> | null;
  readFileImpl?: (path: string) => Promise<string>;
}

function runtimeWith(
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  options: RuntimeOptions = {},
): Pick<McpRuntime, "nodeServicesObservation"> {
  const dashboard = options.dashboard === null
    ? undefined
    : { baseUrl: DASHBOARD_URL, tokenFile: DASHBOARD_TOKEN_FILE, ...options.dashboard };
  const orch = options.orch === null
    ? undefined
    : options.orch?.vaultEnvFile !== undefined
      ? { baseUrl: ORCH_URL, ...options.orch }
      : { baseUrl: ORCH_URL, tokenFile: ORCH_TOKEN_FILE, ...options.orch };
  return {
    nodeServicesObservation: {
      ...(dashboard ? { dashboard } : {}),
      ...(orch ? { orch } : {}),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      readFileImpl: options.readFileImpl ?? (async (path: string) => (
        path === ORCH_TOKEN_FILE ? `${ORCH_TOKEN}\n` : `${DASHBOARD_TOKEN}\n`
      )),
    },
  };
}

describe("observe_node_services configuration", () => {
  it("returns NOT_CONFIGURED from the whole tool when neither side is configured", async () => {
    const fetchImpl = vi.fn();
    const injectedFetch = fetchImpl as unknown as typeof fetch;
    const configs: Array<NodeServicesObservationConfig | undefined> = [
      undefined,
      { fetchImpl: injectedFetch },
      { dashboard: { baseUrl: "", tokenFile: DASHBOARD_TOKEN_FILE }, fetchImpl: injectedFetch },
      { orch: { baseUrl: ORCH_URL, tokenFile: "" }, fetchImpl: injectedFetch },
    ];
    for (const observation of configs) {
      const result = await observeNodeServices(
        { nodeServicesObservation: observation } as unknown as Pick<McpRuntime, "nodeServicesObservation">,
        {},
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: NODE_SERVICES_OBSERVATION_NOT_CONFIGURED });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("marks only the orch side when orch is not configured", async () => {
    const { fetchImpl, calls } = fakeHaniel();
    const result = await observeNodeServices(runtimeWith(fetchImpl, { orch: null }), {
      include_pending: true,
    });
    expect(result.isError).toBeUndefined();
    expect(calls.map((call) => call.url)).toEqual([
      `${DASHBOARD_URL}/api/status`,
      `${DASHBOARD_URL}/api/services`,
    ]);
    expect(result.structuredContent).toMatchObject({
      dashboard: { status: { state: "ok" }, services: { alpha: { state: "running" } } },
      orch: { code: NODE_SERVICES_OBSERVATION_NOT_CONFIGURED },
    });
  });

  it("marks only the dashboard side when dashboard is not configured", async () => {
    const { fetchImpl, calls } = fakeHaniel();
    const result = await observeNodeServices(runtimeWith(fetchImpl, { dashboard: null }), {
      service: "alpha",
      include_logs: true,
    });
    expect(result.isError).toBeUndefined();
    expect(calls.map((call) => call.url)).toEqual([`${ORCH_URL}/api/orch/nodes`]);
    expect(result.structuredContent).toMatchObject({
      dashboard: { code: NODE_SERVICES_OBSERVATION_NOT_CONFIGURED },
      orch: { nodes: { nodes: [{ node_id: "eiaserinnys", state: "ok" }] } },
    });
  });
});

describe("observe_node_services fixed GET client", () => {
  it("defaults to dashboard status/services and orch nodes", async () => {
    const { fetchImpl, calls } = fakeHaniel();
    const result = await observeNodeServices(runtimeWith(fetchImpl), {});
    expect(result.isError).toBeUndefined();
    expect(calls.map((call) => call.url)).toEqual([
      `${DASHBOARD_URL}/api/status`,
      `${DASHBOARD_URL}/api/services`,
      `${ORCH_URL}/api/orch/nodes`,
    ]);
    for (const call of calls) {
      expect(call.init.method).toBe("GET");
      expect(call.init.redirect).toBe("error");
    }
    expect(calls.map((call) => call.init.headers)).toEqual([
      { Authorization: `Bearer ${DASHBOARD_TOKEN}` },
      { Authorization: `Bearer ${DASHBOARD_TOKEN}` },
      { Authorization: `Bearer ${ORCH_TOKEN}` },
    ]);
    expect(result.structuredContent).toMatchObject({
      dashboard: {
        status: { state: "ok" },
        services: { alpha: { state: "running" } },
      },
      orch: { nodes: { nodes: [{ node_id: "eiaserinnys", state: "ok" }] } },
    });
    expect(JSON.stringify(result)).not.toContain(DASHBOARD_TOKEN);
    expect(JSON.stringify(result)).not.toContain(ORCH_TOKEN);
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
      `${DASHBOARD_URL}/api/status`,
      `${DASHBOARD_URL}/api/services`,
    ]);
  });

  it("requests the exact lines count and truncates to the tail", async () => {
    const { fetchImpl, calls } = fakeHaniel();
    const result = await observeNodeServices(runtimeWith(fetchImpl), {
      service: "alpha",
      include_logs: true,
      lines: 3,
    });
    expect(calls[2]?.url).toBe(`${DASHBOARD_URL}/api/services/alpha/logs?lines=3`);
    expect(result.structuredContent).toMatchObject({
      dashboard: { logs: { service: "alpha", lines: ["line-8", "line-9", "line-10"] } },
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
    expect(calls[2]?.url).toBe(`${DASHBOARD_URL}/api/services/weird%2Fname/logs?lines=200`);
  });

  it("fetches pending only when asked and normalizes trailing slashes", async () => {
    const { fetchImpl, calls } = fakeHaniel();
    const result = await observeNodeServices(
      runtimeWith(fetchImpl, {
        dashboard: { baseUrl: `${DASHBOARD_URL}/` },
        orch: { baseUrl: `${ORCH_URL}/` },
      }),
      { include_pending: true },
    );
    expect(result.isError).toBeUndefined();
    expect(calls.map((call) => call.url)).toEqual([
      `${DASHBOARD_URL}/api/status`,
      `${DASHBOARD_URL}/api/services`,
      `${ORCH_URL}/api/orch/nodes`,
      `${ORCH_URL}/api/orch/pending`,
    ]);
    expect(result.structuredContent).toMatchObject({
      orch: { pending: { deploys: [{ service: "alpha" }] } },
    });
  });
});

describe("observe_node_services vault source", () => {
  const vaultCredentials = async () => `VAULT_TOKEN=${VAULT_TOKEN}\n`;

  it("reads the bearer from Vault on every orch request", async () => {
    const { fetchImpl, calls } = fakeHaniel();
    const result = await observeNodeServices(
      runtimeWith(fetchImpl, {
        dashboard: null,
        orch: { vaultEnvFile: ORCH_VAULT_ENV_FILE },
        readFileImpl: vaultCredentials,
      }),
      { include_pending: true },
    );
    expect(result.isError).toBeUndefined();
    expect(calls.map((call) => call.url)).toEqual([
      `${VAULT_URL}${VAULT_SECRET_PATH}`,
      `${ORCH_URL}/api/orch/nodes`,
      `${VAULT_URL}${VAULT_SECRET_PATH}`,
      `${ORCH_URL}/api/orch/pending`,
    ]);
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.redirect).toBe("error");
    expect(calls[0]?.init.headers).toEqual({ "X-Vault-Token": VAULT_TOKEN });
    expect(calls[1]?.init.headers).toEqual({ Authorization: `Bearer ${VAULT_BEARER}` });
    expect(JSON.stringify(result)).not.toContain(VAULT_TOKEN);
    expect(JSON.stringify(result)).not.toContain(VAULT_BEARER);
  });

  it("uses the default Vault address when VAULT_ADDR is absent and honors a declared one", async () => {
    const defaulted = fakeHaniel();
    await observeNodeServices(
      runtimeWith(defaulted.fetchImpl, {
        dashboard: null,
        orch: { vaultEnvFile: ORCH_VAULT_ENV_FILE },
        readFileImpl: vaultCredentials,
      }),
      {},
    );
    expect(defaulted.calls[0]?.url).toBe(`${VAULT_URL}${VAULT_SECRET_PATH}`);

    const declared = fakeHaniel({ vaultUrl: "https://vault.example.test" });
    await observeNodeServices(
      runtimeWith(declared.fetchImpl, {
        dashboard: null,
        orch: { vaultEnvFile: ORCH_VAULT_ENV_FILE },
        readFileImpl: async () =>
          `VAULT_TOKEN=${VAULT_TOKEN}\nVAULT_ADDR=https://vault.example.test/\n`,
      }),
      {},
    );
    expect(declared.calls[0]?.url).toBe(`https://vault.example.test${VAULT_SECRET_PATH}`);
  });

  it("reports vault failures as the orch endpoint error without leaking secrets", async () => {
    const scenarios: Array<{
      name: string;
      readFileImpl: (path: string) => Promise<string>;
      vaultResponse?: () => Response;
      expectText: string;
    }> = [
      {
        name: "missing file",
        readFileImpl: async () => {
          throw new Error("ENOENT: no such file or directory");
        },
        expectText: "ENOENT",
      },
      {
        name: "missing VAULT_TOKEN",
        readFileImpl: async () => "VAULT_ADDR=https://vault.eiaserinnys.me\n",
        expectText: "VAULT_TOKEN",
      },
      {
        name: "non-200",
        readFileImpl: vaultCredentials,
        vaultResponse: () => new Response("vault-error-body-marker", { status: 503 }),
        expectText: "503",
      },
      {
        name: "missing bearer",
        readFileImpl: vaultCredentials,
        vaultResponse: () => Response.json({ data: { data: { bearer: "   " } } }),
        expectText: "bearer",
      },
    ];
    for (const scenario of scenarios) {
      const { fetchImpl } = fakeHaniel(
        scenario.vaultResponse ? { vaultResponse: scenario.vaultResponse } : {},
      );
      const result = await observeNodeServices(
        runtimeWith(fetchImpl, {
          dashboard: null,
          orch: { vaultEnvFile: ORCH_VAULT_ENV_FILE },
          readFileImpl: scenario.readFileImpl,
        }),
        {},
      );
      expect(result.isError, scenario.name).toBe(true);
      expect(result.structuredContent, scenario.name).toMatchObject({
        code: "NODE_SERVICES_OBSERVATION_FAILED",
      });
      expect(String(result.structuredContent?.error), scenario.name).toContain(scenario.expectText);
      expect(JSON.stringify(result), scenario.name).not.toContain(VAULT_TOKEN);
      expect(JSON.stringify(result), scenario.name).not.toContain(VAULT_BEARER);
      expect(JSON.stringify(result), scenario.name).not.toContain("vault-error-body-marker");
    }
  });
});

describe("observe_node_services failure handling", () => {
  it("reports FAILED for non-ok responses without leaking the bearer", async () => {
    const { fetchImpl } = fakeHaniel({ failPath: "/api/services", status: 502 });
    const result = await observeNodeServices(runtimeWith(fetchImpl), {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "NODE_SERVICES_OBSERVATION_FAILED" });
    expect(String(result.structuredContent?.error)).toContain("502");
    expect(JSON.stringify(result)).not.toContain(DASHBOARD_TOKEN);
  });

  it("reports FAILED when the orch side fails", async () => {
    const { fetchImpl, calls } = fakeHaniel({ failPath: "/api/orch/nodes", status: 503 });
    const result = await observeNodeServices(runtimeWith(fetchImpl), {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "NODE_SERVICES_OBSERVATION_FAILED" });
    expect(String(result.structuredContent?.error)).toContain("503");
    expect(calls.map((call) => call.url)).toContain(`${ORCH_URL}/api/orch/nodes`);
    expect(JSON.stringify(result)).not.toContain(ORCH_TOKEN);
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
    for (const options of [
      { dashboard: { baseUrl: "not-a-url" } },
      { orch: { baseUrl: "ftp://127.0.0.1:9398" } },
    ] satisfies RuntimeOptions[]) {
      const result = await observeNodeServices(runtimeWith(fetchImpl, options), {});
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: "NODE_SERVICES_OBSERVATION_FAILED" });
    }
    expect(calls).toHaveLength(0);
  });
});
