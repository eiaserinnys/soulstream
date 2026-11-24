/**
 * 소스 뿌리의 부모 문서 제목 (카드 #1854 V1).
 *
 * atom `/mcp`의 get_node로 부모 노드 ID를 얻고 그 노드의 제목을 읽는다. 어디서 실패해도
 * null이며 미리보기는 실패하지 않는다.
 */
import type { Logger } from "pino";

import type { AtomFetchConfig } from "../atom_context.js";
import { fetchAtomNodeTitle } from "./render_modes.js";

type ParentTitleLogger = Pick<Logger, "warn">;

const PARENT_LOOKUP_TIMEOUT_MS = 10_000;

export async function fetchAtomParentTitle(
  config: AtomFetchConfig,
  nodeId: string,
  logger: ParentTitleLogger,
): Promise<string | null> {
  if (!config.enabled || !config.serverUrl) return null;
  const parentId = await fetchParentNodeId(config, nodeId, logger);
  if (!parentId) return null;
  return await fetchAtomNodeTitle(config, parentId, logger);
}

async function fetchParentNodeId(
  config: AtomFetchConfig,
  nodeId: string,
  logger: ParentTitleLogger,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PARENT_LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.serverUrl.replace(/\/+$/, "")}/mcp`, {
      method: "POST",
      headers: {
        "x-api-key": config.apiKey,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_node", arguments: { node_id: nodeId } },
      }),
      signal: controller.signal,
    });
    if (response.status !== 200) {
      logger.warn({ status: response.status, nodeId }, "[atom] parent lookup failed");
      return null;
    }
    return parentNodeIdFromEnvelope(await response.text());
  } catch (err) {
    logger.warn({ err, nodeId }, "[atom] parent lookup error");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 응답은 SSE(`data: {json}`)나 일반 JSON이다. */
function parentNodeIdFromEnvelope(body: string): string | null {
  const dataLines = body.split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  for (const candidate of dataLines.length > 0 ? dataLines : [body]) {
    try {
      const envelope = JSON.parse(candidate) as {
        result?: { content?: Array<{ text?: unknown }> };
      };
      const text = envelope.result?.content?.find((item) => typeof item.text === "string")?.text;
      if (typeof text !== "string") continue;
      const node = JSON.parse(text) as { parent_node_id?: unknown };
      return typeof node.parent_node_id === "string" ? node.parent_node_id : null;
    } catch {
      continue;
    }
  }
  return null;
}
