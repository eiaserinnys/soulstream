import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseOrchestrationPolicy } from "@soulstream/wire-schema/card-orchestration";
import {
  PersistenceHostTransport,
  readOrchErrorEnvelope,
} from "../../control_plane/persistence_host_transport.js";
import {
  isCurrentMcpCallerExternal,
  getCurrentMcpCallerSessionId,
} from "../request_context.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import { resolveMcpCallerAttribution } from "./caller_session.js";
const policySchema = z
  .object({
    enabled: z.boolean(),
    candidates: z.array(
      z
        .object({
          agentId: z.string().min(1),
          nodeId: z.string().min(1),
          modelPreset: z.string().min(1),
          minimumRemainingPercent: z.number().min(0).max(100),
        })
        .strict(),
    ),
    usageMaxAgeMs: z.literal(300000),
    sessionFolderId: z.uuid().nullable(),
    systemFolderParentId: z.uuid().nullable(),
  })
  .strict();
export function registerCardOrchestrationTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "get_card_orchestration_settings",
    {
      description:
        "관리자 전용 중앙 카드 배정 정책과 최근 판단 상태를 조회한다. 판단 세션은 사용할 수 없다.",
      inputSchema: { caller_session_id: z.string().min(1).optional() },
    },
    async ({ caller_session_id }) =>
      call(runtime, caller_session_id, "get", {}),
  );
  server.registerTool(
    "update_card_orchestration_settings",
    {
      description:
        "관리자 전용 중앙 카드 배정 정책을 CAS version으로 저장한다. 후보 배열 순서가 모델 우선순위이며 사용량은 원천 관측 5분 이내여야 한다. 저장 폴더 null은 첫 판단 직전 서버가 생성한다. 기존 설정 version을 먼저 조회한다.",
      inputSchema: {
        caller_session_id: z.string().min(1).optional(),
        expectedVersion: z.number().int().positive(),
        policy: policySchema,
      },
    },
    async ({ caller_session_id, expectedVersion, policy }) =>
      call(runtime, caller_session_id, "update", {
        expectedVersion,
        policy: parseOrchestrationPolicy(policy),
      }),
  );
}
async function call(
  runtime: McpRuntime,
  explicitSessionId: string | undefined,
  operation: "get" | "update",
  body: Record<string, unknown>,
) {
  if (isCurrentMcpCallerExternal())
    return errorResult(
      "Untrusted external callers cannot access card orchestration settings",
    );
  const headerSessionId = getCurrentMcpCallerSessionId();
  if (
    headerSessionId &&
    explicitSessionId?.trim() &&
    explicitSessionId.trim() !== headerSessionId
  ) {
    return errorResult(
      "caller_session_id must match the authenticated request session header",
    );
  }
  const attribution = resolveMcpCallerAttribution(
    runtime,
    headerSessionId ?? explicitSessionId,
  );
  if (!attribution.callerSessionId)
    return errorResult("A trusted persisted caller session is required");
  if (!runtime.orch) return errorResult("Orchestrator is not configured");
  try {
    const response = await new PersistenceHostTransport({
      orch: runtime.orch,
      logger: runtime.logger,
    }).send("POST", `/api/card-orchestration/host/${operation}`, {
      ...body,
      callerSessionId: attribution.callerSessionId,
    });
    if (!response.ok) {
      const error = await readOrchErrorEnvelope(response);
      return errorResult(`${error.code ?? response.status}: ${error.message}`);
    }
    return jsonResult(await response.json());
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
}
