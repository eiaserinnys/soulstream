import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MODEL_REASONING_EFFORTS } from "@soulstream/model-catalog";
import { z } from "zod";

import { UnknownModelPresetError } from "../../model_catalog.js";
import { errorResult, errorResultFromError, jsonResult } from "../result.js";
import { appendModelPresetLookupHint } from "./model_preset_hint.js";
import type { McpRuntime } from "../runtime.js";

export function registerPersistentSessionTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "set_session_persistent",
    {
      description: "세션의 퍼시스턴트 표시를 켜거나 끈다.",
      inputSchema: {
        session_id: z.string().min(1),
        enabled: z.boolean(),
      },
    },
    async ({ session_id, enabled }) => {
      try {
        const result = await runtime.taskManager.persistentSessions
          .setSessionPersistent(session_id, enabled);
        return jsonResult({
          session_id: result.sessionId,
          persistent: result.persistent,
          generation: result.generation,
        });
      } catch (err) {
        return errorResultFromError(err);
      }
    },
  );

  server.registerTool(
    "request_session_generation_rollover",
    {
      description: "퍼시스턴트 세션의 다음 실행에서 새 모델 세션으로 교체하도록 요청한다.",
      inputSchema: {
        session_id: z.string().min(1),
        model_preset: z.string().min(1).optional(),
        reasoning_effort: z.enum(MODEL_REASONING_EFFORTS).optional(),
        reason: z.string().optional(),
      },
    },
    async ({ session_id, model_preset, reasoning_effort, reason }) => {
      try {
        const result = await runtime.taskManager.persistentSessions
          .requestGenerationRollover(session_id, {
            modelPreset: model_preset,
            reasoningEffort: reasoning_effort,
            reason: reason ?? "manual",
          });
        return jsonResult({
          session_id: result.sessionId,
          generation: result.generation,
          pending_generation: result.pendingGeneration,
          session_status: result.sessionStatus,
          applies: result.applies,
        });
      } catch (err) {
        if (err instanceof UnknownModelPresetError) {
          return errorResult(appendModelPresetLookupHint(err.message, runtime.nodeId));
        }
        return errorResultFromError(err);
      }
    },
  );
}
