/**
 * session_mgmt 도구 — Python `mcp_session_mgmt.py` 정합 (키 호환).
 */
import { randomUUID } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { buildCallerInfoFromCallerSession } from "../../caller_info.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import { resolveEffectiveCallerSessionId } from "./caller_session.js";

export function registerSessionMgmtTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "list_local_agents",
    {
      description: "현재 노드에서 사용 가능한 에이전트 목록.",
      inputSchema: {},
    },
    async () => {
      return jsonResult({
        agents: runtime.agentRegistry.list().map((p) => ({
          id: p.id,
          name: p.name,
          backend: p.backend,
          max_turns: p.max_turns ?? null,
        })),
      });
    },
  );

  server.registerTool(
    "create_agent_session",
    {
      description:
        "현재 노드에 새 에이전트 세션을 생성한다. 비동기 — 세션 ID만 반환. caller_session_id가 있으면 caller_info(v1)를 자동 조립.",
      inputSchema: {
        agent_id: z.string().optional(),
        prompt: z.string(),
        caller_session_id: z.string().optional(),
        folder_id: z.string().optional(),
      },
    },
    async ({ agent_id, prompt, caller_session_id, folder_id }) => {
      // agent_id가 미지정이면 첫 번째 등록 agent를 default로.
      const agents = runtime.agentRegistry.list();
      if (agents.length === 0) {
        return errorResult("등록된 agent가 없습니다");
      }
      const firstAgent = agents[0];
      // 위 length 가드 후이지만 TS strict의 array index undefined 추론을 닫기 위해 명시 확인.
      if (!firstAgent) {
        return errorResult("등록된 agent가 없습니다");
      }
      const resolvedAgentId = agent_id ?? firstAgent.id;
      const agent = runtime.agentRegistry.get(resolvedAgentId);
      if (!agent) {
        return errorResult(`agent_id를 찾을 수 없습니다: ${resolvedAgentId}`);
      }

      // caller_info 조립 — 명시 caller_session_id 우선, 없으면 MCP request context 사용.
      const effectiveCallerSessionId = resolveEffectiveCallerSessionId(caller_session_id);
      const callerInfo = effectiveCallerSessionId
        ? buildCallerInfoFromCallerSession(runtime, effectiveCallerSessionId)
        : undefined;

      const sessionId = randomUUID();
      try {
        const task = await runtime.taskManager.createTask({
          agentSessionId: sessionId,
          prompt,
          profileId: resolvedAgentId,
          callerSessionId: effectiveCallerSessionId ?? null,
          callerInfo,
          folderId: folder_id ?? null,
        });
        // fire-and-forget — 도구는 await 하지 않는다.
        runtime.taskExecutor.startExecution(task, agent);
        return jsonResult({
          agent_session_id: task.agentSessionId,
          status: task.status,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(msg);
      }
    },
  );

  server.registerTool(
    "send_message_to_session",
    {
      description:
        "대상 세션에 메시지 전달. running 시 queue, 종료된 세션은 auto-resume. local 실패 시 orch /intervene fallback.",
      inputSchema: {
        target_session_id: z.string(),
        message: z.string(),
        caller_session_id: z.string().optional(),
      },
    },
    async ({ target_session_id, message, caller_session_id }) => {
      const effectiveCallerSessionId = resolveEffectiveCallerSessionId(caller_session_id);
      const callerInfo = effectiveCallerSessionId
        ? buildCallerInfoFromCallerSession(runtime, effectiveCallerSessionId)
        : undefined;

      let localError: string | null = null;
      try {
        // TaskManager.addIntervention의 두 번째 인자 onResume이 auto-resume 분기에서 호출됨.
        // 콜백 안에서 TaskExecutor.startExecution을 trigger — Python `mcp_session_mgmt.py`
        // L153-161 (auto_resumed 분기 후 start_execution 호출) 정합.
        const result = await runtime.taskManager.addIntervention(
          {
            agentSessionId: target_session_id,
            text: message,
            user: "agent",
            callerInfo,
          },
          (task) => {
            if (!task.profileId) return;
            const agent = runtime.agentRegistry.get(task.profileId);
            if (!agent) return;
            runtime.taskExecutor.startExecution(task, agent);
          },
        );
        return jsonResult({ ok: true, detail: result });
      } catch (err) {
        localError = err instanceof Error ? err.message : String(err);
        runtime.logger.warn(
          { err, targetSessionId: target_session_id },
          "send_message_to_session local delivery failed — trying orch fallback",
        );
      }

      const orch = runtime.orch;
      if (!orch) {
        return jsonResult({
          ok: false,
          error: localError,
          fallback_error: "orch fallback unavailable",
        });
      }

      try {
        await relayMessageToOrch(orch, target_session_id, message, callerInfo);
        return jsonResult({
          ok: true,
          detail: {
            relayed: true,
            target_session_id,
            local_error: localError,
          },
        });
      } catch (err) {
        const fallbackError = err instanceof Error ? err.message : String(err);
        return jsonResult({
          ok: false,
          error: localError,
          fallback_error: fallbackError,
        });
      }
    },
  );

  server.registerTool(
    "get_session_name",
    {
      description: "세션 표시 이름 조회.",
      inputSchema: { session_id: z.string() },
    },
    async ({ session_id }) => {
      const session = await runtime.db.getSession(session_id);
      if (!session) {
        return errorResult(`세션을 찾을 수 없습니다: ${session_id}`);
      }
      return jsonResult({
        session_id,
        display_name: session.display_name,
      });
    },
  );

  server.registerTool(
    "set_session_name",
    {
      description:
        "세션 표시 이름 설정. 빈 문자열 → 제거. CatalogService 경유로 broadcastCatalog 자동.",
      inputSchema: {
        session_id: z.string(),
        name: z.string().default(""),
      },
    },
    async ({ session_id, name }) => {
      const trimmed = (name ?? "").trim();
      const displayName = trimmed.length > 0 ? trimmed : null;
      const session = await runtime.db.getSession(session_id);
      if (!session) {
        return errorResult(`세션을 찾을 수 없습니다: ${session_id}`);
      }
      await runtime.catalogService.renameSession(session_id, displayName);
      return jsonResult({
        session_id,
        display_name: displayName,
      });
    },
  );

  server.registerTool(
    "release_supervisor_wake_dispatch",
    {
      description:
        "blocked supervisor wake dispatch를 수동 해제해 1회 재시도 상태로 전환한다. cursor/backlog는 건드리지 않는다.",
      inputSchema: {
        role: z.string().min(1),
      },
    },
    async ({ role }) => {
      try {
        const registry = await runtime.db.setSupervisorWakeDispatchState({
          role,
          state: "retrying",
          lastSignature: null,
          repeatCount: 0,
          blockedReason: null,
          blockedAt: null,
        });
        runtime.logger.info(
          { role },
          "Supervisor wake dispatch manually released for one retry",
        );
        return jsonResult({
          ok: true,
          role: registry.role,
          wake_dispatch_state: registry.wakeDispatchState,
          wake_repeat_count: registry.wakeRepeatCount,
          wake_last_signature: registry.wakeLastSignature,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(msg);
      }
    },
  );
}

async function relayMessageToOrch(
  orch: { baseUrl: string; headers: Record<string, string> },
  targetSessionId: string,
  message: string,
  callerInfo: unknown,
): Promise<void> {
  const url = `${orch.baseUrl}/api/sessions/${targetSessionId}/intervene`;
  const body: Record<string, unknown> = {
    text: message,
    user: "agent",
  };
  if (callerInfo !== undefined) {
    // orch InterveneRequest의 Pydantic 필드명은 snake_case. camelCase callerInfo 금지.
    body.caller_info = callerInfo;
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      ...orch.headers,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(
      `orch POST /api/sessions/${targetSessionId}/intervene failed: ${resp.status} ${resp.statusText}`,
    );
  }
}
