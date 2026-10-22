import { readPersistentEnabled } from "@soulstream/wire-schema/persistent-session-settings";
import type { NodeResourceSnapshot } from "@soulstream/wire-schema/node-resources";
import { parseNodeResourceSnapshot } from "@soulstream/wire-schema/node-resources";
import type { Logger } from "pino";

import type { SessionDB } from "../db/session_db.js";
import type { SessionRow } from "../db/session_db_types.js";
import type { Task } from "../task/task_models.js";
import type { ContextItem } from "./prompt_assembler.js";

export interface NodeResourcesContextConfig {
  baseUrl: string;
  headers: Record<string, string>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 1500;
const UNAVAILABLE_CONTENT = "노드 자원 상태 조회 불가 (오케스트레이터 응답 없음)";

export async function resolvePasNodeResourcesContextItem(
  db: Pick<SessionDB, "getSession">,
  cfg: NodeResourcesContextConfig | undefined,
  task: Pick<Task, "agentSessionId" | "persistent" | "metadata">,
  preloadedSession: Pick<SessionRow, "metadata"> | null | undefined,
  logger: Logger,
): Promise<ContextItem | null> {
  if (!cfg) return null;
  if (task.persistent === true) return await fetchNodeResourcesContextItem(cfg, logger);

  let metadata: unknown = task.metadata;
  if (preloadedSession !== undefined) {
    metadata = preloadedSession?.metadata ?? task.metadata;
  } else {
    try {
      const session = await db.getSession(task.agentSessionId);
      metadata = session?.metadata ?? task.metadata;
    } catch (err) {
      logger.warn(
        { err, sessionId: task.agentSessionId },
        "node resources PAS metadata unavailable",
      );
    }
  }
  return readPersistentEnabled(metadata)
    ? await fetchNodeResourcesContextItem(cfg, logger)
    : null;
}

export async function fetchNodeResourcesContextItem(
  cfg: NodeResourcesContextConfig,
  logger: Logger,
): Promise<ContextItem> {
  try {
    const nodes = await fetchNodeSnapshots(cfg);
    return {
      key: "node_resources",
      label: "노드 자원 상태",
      content: formatNodeResourcesContext(nodes),
    };
  } catch (err) {
    logger.warn({ err }, "node resources context unavailable");
    return {
      key: "node_resources",
      label: "노드 자원 상태",
      content: UNAVAILABLE_CONTENT,
    };
  }
}

export function formatNodeResourcesContext(nodes: unknown): string {
  const records = Array.isArray(nodes)
    ? nodes.filter((node): node is Record<string, unknown> =>
        isRecord(node) && typeof node.nodeId === "string" && typeof node.status === "string")
    : [];
  if (records.length === 0) return "노드 자원 상태 (연결된 노드 없음)";
  return [
    `노드 자원 상태 (${records.length}개 노드)`,
    ...records.map(formatNode),
  ].join("\n");
}

async function fetchNodeSnapshots(cfg: NodeResourcesContextConfig): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const response = await fetch(`${cfg.baseUrl}/api/nodes?includeDisconnected=true`, {
      method: "GET",
      headers: {
        "content-type": "application/json",
        ...cfg.headers,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`node snapshot request failed with HTTP ${response.status}`);
    const body = await response.json() as { nodes?: unknown };
    return body.nodes;
  } finally {
    clearTimeout(timeout);
  }
}

function formatNode(node: Record<string, unknown>): string {
  const nodeId = node.nodeId as string;
  const status = node.status as string;
  const resources = parseNodeResourceSnapshot(node.resources);
  if (!resources) return `- ${nodeId} [${status}]: 자원 측정 대기 중`;
  const collectedAt = resources.collectedAt;
  const measured = collectedAt ? `, 측정 ${collectedAt}` : "";
  return `- ${nodeId} [${status}${measured}]: ${formatResourceSnapshot(resources)}`;
}

function formatResourceSnapshot(resources: NodeResourceSnapshot): string {
  const cpu = resources.cpu;
  const memory = resources.memory;
  const diskPart = resources.disk
    ? `DISK ${resources.disk.usagePercent.toFixed(1)}% (${toGiB(resources.disk.usedBytes)}/${toGiB(resources.disk.totalBytes)} GiB, 가용 ${toGiB(resources.disk.availableBytes)} GiB, ${resources.disk.path})`
    : "DISK 측정 불가";
  const queue = resources.diskQueue;
  const diskQueuePart = queue
    ? `DISK queue ${queue.device} (in-flight ${queue.inFlight}, avg ${queue.avgQueueDepth.toFixed(2)}, busy ${queue.busyPercent.toFixed(1)}%)`
    : "DISK queue 측정 불가";
  return `CPU ${cpu.usagePercent.toFixed(1)}% (${cpu.cores}c${cpu.loadAvg1m !== null ? `, load ${cpu.loadAvg1m.toFixed(2)}` : ""}) | RAM ${memory.usagePercent.toFixed(1)}% (${toGiB(memory.usedBytes)}/${toGiB(memory.totalBytes)} GiB, 가용 ${toGiB(memory.availableBytes)} GiB) | ${diskPart} | ${diskQueuePart}`;
}

function toGiB(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
