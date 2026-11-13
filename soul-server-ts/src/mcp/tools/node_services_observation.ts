/**
 * observe_node_services — 고정 Haniel GET만 수행하는 읽기 전용 관측 도구.
 *
 * 계약(세션 격리 스펙 §5):
 * - 입력은 ObservationOptions뿐이다. URL·path·method·임의 query를 받지 않는다.
 * - 호출 가능한 endpoint는 아래 다섯 종류가 전부다. 제어 메서드와 다른 경로는
 *   client 코드에 존재하지 않는다.
 *   dashboard: /api/status, /api/services, /api/services/{name}/logs
 *   orch:      /api/orch/pending, /api/orch/nodes
 * - redirect를 따라 다른 endpoint로 가지 않는다(redirect: "error").
 * - bearer는 각 endpoint의 tokenFile에서 읽거나, 볼트 출처면 vaultEnvFile의
 *   VAULT_TOKEN으로 Vault KV v2(secret/shared/haniel)의 bearer를 읽어
 *   Authorization 헤더로만 쓰고, 반환값·로그·CLI env에 넣지 않는다.
 *   볼트 토큰·bearer·볼트 응답 본문도 오류 문구에 넣지 않는다.
 * - 한쪽 설정이 없으면 그쪽 결과만 NODE_SERVICES_OBSERVATION_NOT_CONFIGURED로
 *   표시하고 다른 쪽은 그대로 돌려준다. 둘 다 없으면 도구 전체가 NOT_CONFIGURED다.
 */
import { readFile as defaultReadFile } from "node:fs/promises";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import dotenv from "dotenv";
import { z } from "zod";

import type { ObservationOptions } from "../../security/session_isolation_contract.js";
import { errorResult, jsonResult } from "../result.js";
import type {
  McpRuntime,
  NodeServicesObservationConfig,
  NodeServicesObservationEndpointConfig,
} from "../runtime.js";

export const NODE_SERVICES_OBSERVATION_NOT_CONFIGURED =
  "NODE_SERVICES_OBSERVATION_NOT_CONFIGURED";

const MAX_LOG_LINES = 200;
const DEFAULT_LOG_LINES = 200;
const REQUEST_TIMEOUT_MS = 10_000;
const ERROR_BODY_LIMIT = 500;
/** 볼트 출처 상수. 공통 파일 haniel_endpoint.py와 같은 KV v2 위치를 쓴다. */
const VAULT_DEFAULT_ADDR = "https://vault.eiaserinnys.me";
const VAULT_KV_MOUNT = "secret";
const VAULT_SECRET_PATH = "shared/haniel";
const VAULT_BEARER_KEY = "bearer";

/** 고정 GET 목록. 이 union 밖의 요청은 만들 수 없다. */
type HanielReadRequest =
  | { kind: "status" }
  | { kind: "services" }
  | { kind: "logs"; service: string; lines: number }
  | { kind: "pending" }
  | { kind: "nodes" };

export function registerNodeServicesObservationTool(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "observe_node_services",
    {
      description:
        "Haniel 노드의 서비스 상태와 로그를 읽기 전용으로 관측한다. 고정 GET(dashboard: /api/status, /api/services, 서비스 로그 / orch: /api/orch/pending, /api/orch/nodes)만 호출하며 재시작·배포 같은 제어는 하지 않는다.",
      inputSchema: {
        service: z.string().min(1).optional(),
        include_logs: z.boolean().optional(),
        lines: z.number().int().min(1).max(MAX_LOG_LINES).optional(),
        include_pending: z.boolean().optional(),
      },
    },
    async (input: ObservationOptions) => observeNodeServices(runtime, input),
  );
}

export async function observeNodeServices(
  runtime: Pick<McpRuntime, "nodeServicesObservation">,
  input: ObservationOptions,
) {
  const config = runtime.nodeServicesObservation;
  const dashboard = usableEndpoint(config?.dashboard);
  const orch = usableEndpoint(config?.orch);
  if (!dashboard && !orch) {
    return errorResult(
      "observe_node_services is not configured on this node (dashboard and orch Haniel settings missing).",
      { code: NODE_SERVICES_OBSERVATION_NOT_CONFIGURED },
    );
  }

  const includeLogs = input.include_logs === true;
  const includePending = input.include_pending === true;
  const service = input.service;
  const lines = input.lines ?? DEFAULT_LOG_LINES;
  if (includeLogs && !service) {
    return errorResult("service is required when include_logs is true.", {
      code: "NODE_SERVICES_OBSERVATION_INVALID_INPUT",
    });
  }
  if (!Number.isInteger(lines) || lines < 1 || lines > MAX_LOG_LINES) {
    return errorResult(`lines must be an integer between 1 and ${MAX_LOG_LINES}.`, {
      code: "NODE_SERVICES_OBSERVATION_INVALID_INPUT",
    });
  }

  let dashboardBase: string | undefined;
  let orchBase: string | undefined;
  try {
    if (dashboard) dashboardBase = normalizeBaseUrl("dashboard", dashboard.baseUrl);
    if (orch) orchBase = normalizeBaseUrl("orch", orch.baseUrl);
  } catch (error) {
    return errorResult(errorMessage(error), {
      code: "NODE_SERVICES_OBSERVATION_FAILED",
    });
  }

  const fetchImpl = config?.fetchImpl ?? fetch;
  const readFileImpl = config?.readFileImpl ?? ((path: string) => defaultReadFile(path, "utf8"));

  try {
    const result: Record<string, unknown> = {};

    if (dashboard && dashboardBase) {
      const client = createHanielReadClient(dashboard, dashboardBase, fetchImpl, readFileImpl);
      const status = await client.get({ kind: "status" });
      const services = await client.get({ kind: "services" });
      const dashboardResult: Record<string, unknown> = { status, services };

      if (includeLogs && service) {
        const names = serviceNames(services);
        if (!names.includes(service)) {
          return errorResult(`unknown service: ${service}`, {
            code: "NODE_SERVICES_OBSERVATION_INVALID_SERVICE",
            details: { services: names },
          });
        }
        const logs = await client.get({ kind: "logs", service, lines });
        dashboardResult.logs = truncateLogs(logs, lines);
      }
      result.dashboard = dashboardResult;
    } else {
      result.dashboard = notConfigured();
    }

    if (orch && orchBase) {
      const client = createHanielReadClient(orch, orchBase, fetchImpl, readFileImpl);
      const orchResult: Record<string, unknown> = {
        nodes: await client.get({ kind: "nodes" }),
      };
      if (includePending) {
        orchResult.pending = await client.get({ kind: "pending" });
      }
      result.orch = orchResult;
    } else {
      result.orch = notConfigured();
    }

    return jsonResult(result);
  } catch (error) {
    return errorResult(errorMessage(error), {
      code: "NODE_SERVICES_OBSERVATION_FAILED",
    });
  }
}

interface HanielReadClient {
  get(request: HanielReadRequest): Promise<unknown>;
}

function createHanielReadClient(
  endpoint: NodeServicesObservationEndpointConfig,
  baseUrl: string,
  fetchImpl: typeof fetch,
  readFileImpl: (path: string) => Promise<string>,
): HanielReadClient {
  return {
    async get(request: HanielReadRequest): Promise<unknown> {
      const token = await resolveBearer(endpoint, readFileImpl, fetchImpl);
      const path = fixedPath(request);
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        const body = await safeText(response);
        throw new Error(
          `Haniel GET ${path} failed with ${response.status}${body ? `: ${body}` : ""}`,
        );
      }
      return response.json();
    },
  };
}

/** 고정 경로만 만든다. 이름은 encodeURIComponent로 한 segment에 가둔다. */
function fixedPath(request: HanielReadRequest): string {
  switch (request.kind) {
    case "status":
      return "/api/status";
    case "services":
      return "/api/services";
    case "logs":
      return `/api/services/${encodeURIComponent(request.service)}/logs?lines=${request.lines}`;
    case "pending":
      return "/api/orch/pending";
    case "nodes":
      return "/api/orch/nodes";
  }
}

function usableEndpoint(
  endpoint: NodeServicesObservationEndpointConfig | undefined,
): NodeServicesObservationEndpointConfig | undefined {
  if (!endpoint || !endpoint.baseUrl) return undefined;
  const sources = [endpoint.tokenFile, endpoint.vaultEnvFile].filter((value) => !!value);
  if (sources.length !== 1) return undefined;
  return endpoint;
}

function notConfigured(): { code: string } {
  return { code: NODE_SERVICES_OBSERVATION_NOT_CONFIGURED };
}

async function resolveBearer(
  endpoint: NodeServicesObservationEndpointConfig,
  readFileImpl: (path: string) => Promise<string>,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (endpoint.vaultEnvFile) {
    return readVaultBearer(endpoint.vaultEnvFile, readFileImpl, fetchImpl);
  }
  if (!endpoint.tokenFile) {
    throw new Error("Haniel endpoint has no token source.");
  }
  return readToken(endpoint.tokenFile, readFileImpl);
}

async function readToken(
  tokenFile: string,
  readFileImpl: (path: string) => Promise<string>,
): Promise<string> {
  const token = (await readFileImpl(tokenFile)).trim();
  if (!token) {
    throw new Error("Haniel API token file is empty.");
  }
  return token;
}

/**
 * 볼트 출처: 요청마다 자격 파일을 다시 읽고 KV v2에서 허브 bearer를 가져온다.
 * 값은 캐시하지 않는다. 오류 문구에는 상태 코드와 까닭만 남긴다.
 */
async function readVaultBearer(
  vaultEnvFile: string,
  readFileImpl: (path: string) => Promise<string>,
  fetchImpl: typeof fetch,
): Promise<string> {
  const credentials = dotenv.parse(await readFileImpl(vaultEnvFile));
  const vaultToken = credentials.VAULT_TOKEN?.trim();
  if (!vaultToken) {
    throw new Error("Haniel vault env file has no VAULT_TOKEN.");
  }
  const vaultAddr = (credentials.VAULT_ADDR?.trim() || VAULT_DEFAULT_ADDR).replace(/\/+$/, "");
  const secretPath = `/v1/${VAULT_KV_MOUNT}/data/${VAULT_SECRET_PATH}`;
  const response = await fetchImpl(`${vaultAddr}${secretPath}`, {
    method: "GET",
    headers: { "X-Vault-Token": vaultToken },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Vault GET ${secretPath} failed with ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // JSON.parse 오류 문구는 입력 조각을 담을 수 있으므로 본문을 그대로 싣지 않는다.
    throw new Error(`Vault GET ${secretPath} returned a non-JSON body.`);
  }
  const bearer = vaultBearerValue(body);
  if (!bearer) {
    throw new Error(`Vault secret ${VAULT_SECRET_PATH} has no ${VAULT_BEARER_KEY}.`);
  }
  return bearer;
}

function vaultBearerValue(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const data = (body as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return undefined;
  const values = (data as { data?: unknown }).data;
  if (values === null || typeof values !== "object") return undefined;
  const bearer = (values as Record<string, unknown>)[VAULT_BEARER_KEY];
  return typeof bearer === "string" && bearer.trim() ? bearer.trim() : undefined;
}

function normalizeBaseUrl(side: string, value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${side} Haniel base URL is not a valid URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${side} Haniel base URL must be an http(s) URL.`);
  }
  return trimmed;
}

function serviceNames(services: unknown): string[] {
  if (services === null || typeof services !== "object" || Array.isArray(services)) {
    return [];
  }
  return Object.keys(services);
}

/** 요청 lines 이하, 최대 200줄. Haniel 응답의 lines 배열을 그대로 자른다. */
function truncateLogs(logs: unknown, lines: number): unknown {
  const cap = Math.min(lines, MAX_LOG_LINES);
  if (logs === null || typeof logs !== "object" || Array.isArray(logs)) {
    return logs;
  }
  const record = logs as Record<string, unknown>;
  if (!Array.isArray(record.lines)) {
    return logs;
  }
  return { ...record, lines: record.lines.slice(-cap) };
}

async function safeText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > ERROR_BODY_LIMIT ? `${text.slice(0, ERROR_BODY_LIMIT)}…` : text;
  } catch {
    return "";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
