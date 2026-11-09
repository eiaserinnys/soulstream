/**
 * observe_node_services — 고정 Haniel GET만 수행하는 읽기 전용 관측 도구.
 *
 * 계약(세션 격리 스펙 §5):
 * - 입력은 ObservationOptions뿐이다. URL·path·method·임의 query를 받지 않는다.
 * - 호출 가능한 endpoint는 아래 네 종류가 전부다. 제어 메서드와 다른 경로는
 *   client 코드에 존재하지 않는다.
 * - redirect를 따라 다른 endpoint로 가지 않는다(redirect: "error").
 * - bearer는 tokenFile에서 읽어 Authorization 헤더로만 쓰고, 반환값·로그·CLI env에
 *   넣지 않는다.
 * - HANIEL_API_URL/HANIEL_API_TOKEN_FILE 중 하나라도 미설정이면 이 도구만
 *   NODE_SERVICES_OBSERVATION_NOT_CONFIGURED를 반환한다.
 */
import { readFile as defaultReadFile } from "node:fs/promises";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ObservationOptions } from "../../security/session_isolation_contract.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime, NodeServicesObservationConfig } from "../runtime.js";

export const NODE_SERVICES_OBSERVATION_NOT_CONFIGURED =
  "NODE_SERVICES_OBSERVATION_NOT_CONFIGURED";

const MAX_LOG_LINES = 200;
const DEFAULT_LOG_LINES = 200;
const REQUEST_TIMEOUT_MS = 10_000;
const ERROR_BODY_LIMIT = 500;

/** 고정 GET 목록. 이 union 밖의 요청은 만들 수 없다. */
type HanielReadRequest =
  | { kind: "status" }
  | { kind: "services" }
  | { kind: "logs"; service: string; lines: number }
  | { kind: "pending" };

export function registerNodeServicesObservationTool(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "observe_node_services",
    {
      description:
        "Haniel 노드의 서비스 상태와 로그를 읽기 전용으로 관측한다. 고정 GET(/api/status, /api/services, 서비스 로그, 배포 대기)만 호출하며 재시작·배포 같은 제어는 하지 않는다.",
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
  if (!config || !config.baseUrl || !config.tokenFile) {
    return errorResult(
      "observe_node_services is not configured on this node (HANIEL_API_URL / HANIEL_API_TOKEN_FILE missing).",
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

  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(config.baseUrl);
  } catch (error) {
    return errorResult(errorMessage(error), {
      code: "NODE_SERVICES_OBSERVATION_FAILED",
    });
  }

  try {
    const client = createHanielReadClient(config, baseUrl);
    const status = await client.get({ kind: "status" });
    const services = await client.get({ kind: "services" });
    const result: Record<string, unknown> = { status, services };

    if (includeLogs && service) {
      const names = serviceNames(services);
      if (!names.includes(service)) {
        return errorResult(`unknown service: ${service}`, {
          code: "NODE_SERVICES_OBSERVATION_INVALID_SERVICE",
          details: { services: names },
        });
      }
      const logs = await client.get({ kind: "logs", service, lines });
      result.logs = truncateLogs(logs, lines);
    }
    if (includePending) {
      result.pending = await client.get({ kind: "pending" });
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
  config: NodeServicesObservationConfig,
  baseUrl: string,
): HanielReadClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const readFileImpl = config.readFileImpl ?? ((path: string) => defaultReadFile(path, "utf8"));

  return {
    async get(request: HanielReadRequest): Promise<unknown> {
      const token = await readToken(config.tokenFile, readFileImpl);
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
  }
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

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("HANIEL_API_URL is not a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("HANIEL_API_URL must be an http(s) URL.");
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
