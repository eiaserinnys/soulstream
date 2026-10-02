import { clusterTools } from "@soulstream/mcp-contract";
import { registerOrchestratorTools } from "../orchestrator_tools.js";
import { createCallerInfoPreprocessor } from "./cluster_caller_info.js";
export function registerMultiNodeTools(server: McpServer, runtime: McpRuntime): void {
  registerOrchestratorTools(server, runtime, Object.values(clusterTools), { create_remote_agent_session: createCallerInfoPreprocessor(runtime).create_remote_agent_session });
}
/**
 * multi_node 도구 — Python `mcp_multi_node.py` 정합.
 *
 * runtime.orch 미설정 시 도구는 등록되되 호출 시 `{error: ...}` 반환 (Codex가 도구 surface는
 * 발견하되 실패 사유를 명확히 받게).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  fetchOrchResponse,
  ORCH_NODE_COMMAND_TIMEOUT_MS,
  readOrchErrorEnvelope,
} from "../../control_plane/persistence_host_transport.js";
import { resolveDelegatedFolderId } from "../../session_folder_fallback.js";
import { resolveStructuralCallerSessionId } from "../../task/delegation_relationship.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import { requireRemoteCallerAttribution } from "./caller_session.js";
import { appendModelPresetLookupHint } from "./model_preset_hint.js";

const NOT_CONFIGURED_MSG = "multi-node not configured";

export function registerMultiNodeToolsLegacy(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "list_nodes",
    clusterTools.list_nodes.config,
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
    clusterTools.list_node_agents.config,
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
    "list_node_model_presets",
    clusterTools.list_node_model_presets.config,
    async ({ node_id }) => {
      const orch = runtime.orch;
      if (!orch) return errorResult(NOT_CONFIGURED_MSG);
      try {
        const data = await fetchOrch(
          orch,
          "GET",
          `/api/nodes/${encodeURIComponent(node_id)}/model-presets`,
        );
        return jsonResult(data);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "reflect_cluster_brief",
    clusterTools.reflect_cluster_brief.config,
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
    clusterTools.plan_remote_agent_profile_update.config,
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
          { timeoutMs: ORCH_NODE_COMMAND_TIMEOUT_MS },
        );
        return jsonResult(data);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "apply_remote_agent_profile_update",
    clusterTools.apply_remote_agent_profile_update.config,
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
          { timeoutMs: ORCH_NODE_COMMAND_TIMEOUT_MS },
        );
        return jsonResult(data);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "list_remote_agents_config_snapshots",
    clusterTools.list_remote_agents_config_snapshots.config,
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
    clusterTools.rollback_remote_agents_config.config,
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
          { timeoutMs: ORCH_NODE_COMMAND_TIMEOUT_MS },
        );
        return jsonResult(data);
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "create_remote_agent_session",
    clusterTools.create_remote_agent_session.config,
    async (input) => {
      const { node_id, agent_id, model_preset, reasoning_effort, prompt, caller_session_id, notify_completion, folder_id, card_id } = input;
      const orch = runtime.orch;
      if (!orch) return errorResult(NOT_CONFIGURED_MSG);

      const caller = requireRemoteCallerAttribution(runtime, caller_session_id);
      if (!caller.ok) return errorResult(caller.error);

      const body: Record<string, unknown> = {
        prompt,
        nodeId: node_id,
      };
      if (agent_id !== undefined) body.profile = agent_id;
      if (model_preset !== undefined) body.model_preset = model_preset;
      if (reasoning_effort !== undefined) body.reasoningEffort = reasoning_effort;
      const resolvedFolderId = await resolveDelegatedFolderId(runtime, {
        callerSessionId: caller.callerSessionId,
        ...(Object.prototype.hasOwnProperty.call(input, "folder_id") && folder_id !== undefined
          ? { folderId: folder_id }
          : {}),
      });
      body.folderId = resolvedFolderId;
      if (card_id !== undefined) {
        body.cardId = card_id;
      }
      if (notify_completion !== undefined) {
        body.notify_completion = notify_completion;
      }
      const structuralCallerSessionId = resolveStructuralCallerSessionId(
        caller.callerSessionId,
        notify_completion,
      );
      if (structuralCallerSessionId !== null) {
        body.caller_session_id = structuralCallerSessionId;
      }
      body.caller_info = caller.callerInfo;

      try {
        const data = await fetchOrch(
          orch,
          "POST",
          "/api/sessions",
          body,
          { timeoutMs: ORCH_NODE_COMMAND_TIMEOUT_MS },
        );
        return jsonResult(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(
          err instanceof OrchHttpError
            && err.code === "MODEL_PRESET_NOT_FOUND"
            ? appendModelPresetLookupHint(
                err.detailMessage ?? message,
                node_id,
              )
            : message,
        );
      }
    },
  );
}

async function fetchOrch(
  orch: { baseUrl: string; headers: Record<string, string> },
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  options: { timeoutMs?: number } = {},
): Promise<unknown> {
  const res = await fetchOrchResponse(orch, method, path, body, options);
  if (!res.ok) {
    const detail = await readOrchErrorEnvelope(res);
    throw new OrchHttpError(
      `orch ${method} ${path} failed: ${res.status} ${res.statusText} ${detail.message}`,
      detail.code ?? undefined,
      detail.message,
    );
  }
  return await res.json();
}

class OrchHttpError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly detailMessage?: string,
  ) {
    super(message);
    this.name = "OrchHttpError";
  }
}
