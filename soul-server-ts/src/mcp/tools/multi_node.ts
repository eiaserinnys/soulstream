/**
 * multi_node 도구 — Python `mcp_multi_node.py` 정합.
 *
 * runtime.orch 미설정 시 도구는 등록되되 호출 시 `{error: ...}` 반환 (Codex가 도구 surface는
 * 발견하되 실패 사유를 명확히 받게).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { AgentProfileSchema } from "../../agent_registry.js";
import { buildCallerInfoFromCallerSession } from "../../caller_info.js";
import { resolveDelegatedContainer } from "../../session_folder_fallback.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import { requireRemoteCallerSessionId } from "./caller_session.js";

const NOT_CONFIGURED_MSG = "multi-node not configured";
const delegatedContainerSchema = z.object({
  kind: z.enum(["folder", "runbook"]),
  id: z.string().min(1),
});

export function registerMultiNodeTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "list_nodes",
    {
      description: "오케스트레이터에 연결된 노드 목록 조회.",
      inputSchema: {},
    },
    async () => {
      const orch = runtime.orch;
      if (!orch) return errorResult(NOT_CONFIGURED_MSG);
      try {
        const data = await fetchOrch(orch, "GET", "/api/nodes");
        return jsonResult(data);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "list_node_agents",
    {
      description: "특정 노드의 에이전트 목록 조회.",
      inputSchema: { node_id: z.string().min(1) },
    },
    async ({ node_id }) => {
      const orch = runtime.orch;
      if (!orch) return errorResult(NOT_CONFIGURED_MSG);
      try {
        const data = await fetchOrch(
          orch,
          "GET",
          `/api/nodes/${encodeURIComponent(node_id)}/agents`,
        );
        return jsonResult(data);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "reflect_cluster_brief",
    {
      description:
        "오케스트레이터를 통해 연결된 TS 노드들의 reflect_brief를 집계한다. 로컬 reflect_brief(self-only)와 별도 도구다.",
      inputSchema: {},
    },
    async () => {
      const orch = runtime.orch;
      if (!orch) return errorResult(NOT_CONFIGURED_MSG);
      try {
        const data = await fetchOrch(orch, "GET", "/cogito/briefs");
        return jsonResult(data);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "plan_remote_agent_profile_update",
    {
      description:
        "오케스트레이터를 통해 대상 노드에 agent profile 변경 계획(diff)만 요청한다. 파일 쓰기와 snapshot 생성은 하지 않는다.",
      inputSchema: {
        node_id: z.string().min(1),
        profile: AgentProfileSchema,
        create_if_missing: z.boolean().default(false),
        include_text_diff: z.boolean().optional(),
        includeTextDiff: z.boolean().optional(),
      },
    },
    async ({ node_id, profile, create_if_missing, include_text_diff, includeTextDiff }) => {
      const orch = runtime.orch;
      if (!orch) return errorResult(NOT_CONFIGURED_MSG);
      try {
        const data = await fetchOrch(
          orch,
          "POST",
          `/api/nodes/${encodeURIComponent(node_id)}/agents/config/plan-profile-update`,
          {
            profile,
            create_if_missing: create_if_missing ?? false,
            include_text_diff: include_text_diff ?? includeTextDiff ?? false,
          },
        );
        return jsonResult(data);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "apply_remote_agent_profile_update",
    {
      description:
        "오케스트레이터를 통해 대상 노드에 agent profile 변경을 실제 적용한다. 파일 write/snapshot/reload는 대상 노드에서 수행한다.",
      inputSchema: {
        node_id: z.string().min(1),
        profile: AgentProfileSchema,
        create_if_missing: z.boolean().default(false),
        include_text_diff: z.boolean().optional(),
        includeTextDiff: z.boolean().optional(),
        expected_config_checksum: z.string().optional(),
        expectedConfigChecksum: z.string().optional(),
      },
    },
    async ({
      node_id,
      profile,
      create_if_missing,
      include_text_diff,
      includeTextDiff,
      expected_config_checksum,
      expectedConfigChecksum,
    }) => {
      const orch = runtime.orch;
      if (!orch) return errorResult(NOT_CONFIGURED_MSG);
      try {
        const data = await fetchOrch(
          orch,
          "POST",
          `/api/nodes/${encodeURIComponent(node_id)}/agents/config/apply-profile-update`,
          {
            profile,
            create_if_missing: create_if_missing ?? false,
            include_text_diff: include_text_diff ?? includeTextDiff ?? false,
            expected_config_checksum:
              expected_config_checksum ?? expectedConfigChecksum,
          },
        );
        return jsonResult(data);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "list_remote_agents_config_snapshots",
    {
      description:
        "오케스트레이터를 통해 대상 노드의 agents.yaml snapshot 목록을 조회한다.",
      inputSchema: { node_id: z.string().min(1) },
    },
    async ({ node_id }) => {
      const orch = runtime.orch;
      if (!orch) return errorResult(NOT_CONFIGURED_MSG);
      try {
        const data = await fetchOrch(
          orch,
          "GET",
          `/api/nodes/${encodeURIComponent(node_id)}/agents/config/snapshots`,
        );
        return jsonResult(data);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "rollback_remote_agents_config",
    {
      description:
        "오케스트레이터를 통해 대상 노드의 agents.yaml을 snapshot path 또는 snapshot id로 rollback한다.",
      inputSchema: {
        node_id: z.string().min(1),
        snapshot_path: z.string().optional(),
        snapshot_id: z.string().optional(),
        include_text_diff: z.boolean().optional(),
        includeTextDiff: z.boolean().optional(),
      },
    },
    async ({
      node_id,
      snapshot_path,
      snapshot_id,
      include_text_diff,
      includeTextDiff,
    }) => {
      const orch = runtime.orch;
      if (!orch) return errorResult(NOT_CONFIGURED_MSG);
      if (!snapshot_path && !snapshot_id) {
        return errorResult("snapshot_path or snapshot_id is required");
      }
      try {
        const data = await fetchOrch(
          orch,
          "POST",
          `/api/nodes/${encodeURIComponent(node_id)}/agents/config/rollback`,
          {
            snapshot_path,
            snapshot_id,
            include_text_diff: include_text_diff ?? includeTextDiff ?? false,
          },
        );
        return jsonResult(data);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "create_remote_agent_session",
    {
      description:
        "다른 노드에 새 에이전트 세션을 생성한다. caller_info(v1)를 자동 조립하여 원격 노드로 전파. notify_completion=false는 런북 기반 워크플로우에서 런북을 추적 표면으로 쓸 때 권장.",
      inputSchema: {
        node_id: z.string().min(1),
        agent_id: z.string().optional(),
        prompt: z.string(),
        caller_session_id: z.string().optional(),
        notify_completion: z.boolean().optional(),
        folder_id: z.string().nullable().optional(),
        container: delegatedContainerSchema.optional(),
        source_runbook_item_id: z.string().optional(),
      },
    },
    async (input) => {
      const { node_id, agent_id, prompt, caller_session_id, notify_completion, folder_id, container, source_runbook_item_id } = input;
      const orch = runtime.orch;
      if (!orch) return errorResult(NOT_CONFIGURED_MSG);

      const callerSession = requireRemoteCallerSessionId(caller_session_id);
      if (!callerSession.ok) return errorResult(callerSession.error);

      const callerInfo = buildCallerInfoFromCallerSession(
        runtime,
        callerSession.callerSessionId,
      );

      if (agent_id !== undefined) {
        const validation = await validateRemoteAgentId(orch, node_id, agent_id);
        if (!validation.ok) return errorResult(validation.message);
      }

      const body: Record<string, unknown> = {
        prompt,
        nodeId: node_id,
      };
      if (agent_id !== undefined) body.profile = agent_id;
      const resolvedContainer = await resolveDelegatedContainer(runtime, {
        callerSessionId: callerSession.callerSessionId,
        ...(Object.prototype.hasOwnProperty.call(input, "folder_id") && folder_id !== undefined
          ? { folderId: folder_id }
          : {}),
        container: container ?? null,
      });
      body.folderId = resolvedContainer.folderId;
      if (resolvedContainer.container) {
        body.container = {
          kind: resolvedContainer.container.containerKind,
          id: resolvedContainer.container.containerId,
        };
      }
      if (source_runbook_item_id !== undefined) {
        body.sourceRunbookItemId = source_runbook_item_id;
      }
      if (notify_completion !== undefined) {
        body.notify_completion = notify_completion;
      }
      body.caller_session_id = callerSession.callerSessionId;
      body.caller_info = callerInfo;

      try {
        const data = await fetchOrch(orch, "POST", "/api/sessions", body);
        return jsonResult(data);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

interface RemoteAgent {
  id: string;
  name?: string;
  backend?: string;
}

type AgentIdValidation =
  | { ok: true }
  | { ok: false; message: string };

async function validateRemoteAgentId(
  orch: { baseUrl: string; headers: Record<string, string> },
  nodeId: string,
  agentId: string,
): Promise<AgentIdValidation> {
  let data: unknown;
  try {
    data = await fetchOrch(
      orch,
      "GET",
      `/api/nodes/${encodeURIComponent(nodeId)}/agents`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `agent_id 검증 실패: ${message}`,
    };
  }

  const agents = parseRemoteAgents(data);
  if (agents.length === 0 || agents.some((agent) => agent.id === agentId)) {
    return { ok: true };
  }

  return {
    ok: false,
    message: [
      `agent_id를 찾을 수 없습니다: ${agentId}`,
      "정확한 id를 사용하세요.",
      `available: ${formatRemoteAgents(agents)}`,
    ].join(" "),
  };
}

function parseRemoteAgents(data: unknown): RemoteAgent[] {
  if (!isRecord(data) || !Array.isArray(data.agents)) return [];
  const agents: RemoteAgent[] = [];
  for (const raw of data.agents) {
    if (!isRecord(raw) || typeof raw.id !== "string") continue;
    agents.push({
      id: raw.id,
      ...(typeof raw.name === "string" ? { name: raw.name } : {}),
      ...(typeof raw.backend === "string" ? { backend: raw.backend } : {}),
    });
  }
  return agents;
}

function formatRemoteAgents(agents: RemoteAgent[]): string {
  return agents
    .map((agent) => {
      const detail = [
        agent.name ? `name=${agent.name}` : null,
        agent.backend ? `backend=${agent.backend}` : null,
      ].filter(Boolean).join(", ");
      return detail ? `${agent.id} (${detail})` : agent.id;
    })
    .join(", ");
}

async function fetchOrch(
  orch: { baseUrl: string; headers: Record<string, string> },
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${orch.baseUrl}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      "content-type": "application/json",
      ...orch.headers,
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `orch ${method} ${path} failed: ${res.status} ${res.statusText}${detail ? ` ${detail}` : ""}`,
    );
  }
  return await res.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
