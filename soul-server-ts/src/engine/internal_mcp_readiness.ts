import { createConnection } from "node:net";

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import {
  isSoulstreamInternalMcpServer,
  normalizeSoulstreamInternalMcpUrl,
} from "./soulstream_internal_mcp.js";

export const DEFAULT_INTERNAL_MCP_READY_TIMEOUT_MS = 60_000;
export const DEFAULT_INTERNAL_MCP_READY_INTERVAL_MS = 500;
const ATTEMPT_TIMEOUT_MS = 1_000;

export interface InternalMcpWaitOptions {
  /** 리스너를 기다리는 전체 상한. 시험에서만 줄인다. */
  timeoutMs?: number;
  /** 확인 재시도 간격. 시험에서만 줄인다. */
  intervalMs?: number;
}

/**
 * Query 옵션의 MCP 서버 중 soulstream 내부 리스너 주소로 다시 쓰인 HTTP
 * 서버가 있으면 그 주소를 돌려준다. 없으면 undefined.
 */
export function internalSoulstreamMcpUrl(
  servers: Record<string, McpServerConfig> | undefined,
  internalMcpUrl: string | undefined,
): string | undefined {
  if (servers === undefined || internalMcpUrl === undefined) return undefined;
  const expected = normalizeSoulstreamInternalMcpUrl(internalMcpUrl);
  for (const [name, config] of Object.entries(servers)) {
    const record = config as { type?: unknown; url?: unknown };
    if (typeof record.type !== "string") continue;
    if (!isSoulstreamInternalMcpServer({ name, type: record.type })) continue;
    if (record.url !== expected) continue;
    return expected;
  }
  return undefined;
}

/**
 * 내부 MCP 리스너가 TCP 연결을 받을 때까지 기다린다. HTTP 응답은 읽지 않는다.
 * 첫 시도는 즉시 하므로 이미 열려 있으면 지연이 없고, 상한을 넘으면 warn
 * 한 줄을 남기고 그대로 진행한다.
 */
export async function waitForInternalMcpListener(
  url: string,
  logger: Logger,
  options: InternalMcpWaitOptions = {},
  signal?: AbortSignal,
): Promise<void> {
  const target = new URL(url);
  const host = target.hostname.replace(/^\[|\]$/g, "");
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const timeoutMs = options.timeoutMs ?? DEFAULT_INTERNAL_MCP_READY_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERNAL_MCP_READY_INTERVAL_MS;
  const startedAt = Date.now();
  let attempts = 0;

  for (;;) {
    attempts += 1;
    if (await probeTcp(host, port, ATTEMPT_TIMEOUT_MS)) {
      if (attempts > 1) {
        logger.info(
          { url, waitedMs: Date.now() - startedAt, attempts },
          "waited for the soulstream internal MCP listener",
        );
      }
      return;
    }
    const waitedMs = Date.now() - startedAt;
    if (waitedMs >= timeoutMs) {
      logger.warn(
        { url, waitedMs, timeoutMs },
        "soulstream internal MCP listener did not open before the timeout; continuing",
      );
      return;
    }
    if (signal?.aborted === true) return;
    await sleep(Math.min(intervalMs, timeoutMs - waitedMs));
  }
}

function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (open: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
