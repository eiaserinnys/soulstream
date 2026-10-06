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

  server.registerTool(
    "list_persistent_instructions",
    {
      description: "퍼시스턴트 세션에 저장된 활성 지시를 조회한다.",
      inputSchema: { session_id: z.string().min(1) },
    },
    async ({ session_id }) => {
      try {
        const instructions = await runtime.taskManager.persistentSessions
          .listPersistentInstructions(session_id);
        const firstLine = instructions[0]?.text ?? "저장된 지속 지시가 없습니다.";
        return withFirstLine({
          session_id,
          instructions: instructions.map(({ id, text, source_turns }) => ({ id, text, source_turns })),
        }, firstLine);
      } catch (err) {
        return errorResultFromError(err);
      }
    },
  );

  server.registerTool(
    "add_persistent_instruction",
    {
      description: "퍼시스턴트 세션에 지속 지시를 추가한다.",
      inputSchema: {
        session_id: z.string().min(1),
        text: z.string().trim().min(1),
      },
    },
    async ({ session_id, text }) => {
      try {
        const result = await runtime.taskManager.persistentSessions.applyPersistentInstructions(session_id, {
          origin: "agent",
          ops: [{ op: "add", text }],
        });
        const outcome = result.results[0]!;
        if (outcome.status === "cap_reached") {
          return withFirstLine({ session_id, status: outcome.status }, "활성 지속 지시 상한에 도달했습니다.");
        }
        return withFirstLine({ session_id, status: outcome.status, instruction: outcome.item }, outcome.item?.text ?? "지시를 추가하지 못했습니다.");
      } catch (err) {
        return errorResultFromError(err);
      }
    },
  );

  server.registerTool(
    "update_persistent_instruction",
    {
      description: "저장된 지속 지시의 문장이나 상태를 바꾼다.",
      inputSchema: {
        session_id: z.string().min(1),
        instruction_id: z.string().min(1),
        text: z.string().trim().min(1).optional(),
        status: z.enum(["active", "removed"]).optional(),
      },
    },
    async ({ session_id, instruction_id, text, status }) => {
      if (text === undefined && status === undefined) return errorResult("text 또는 status가 필요합니다.");
      try {
        const result = await runtime.taskManager.persistentSessions.applyPersistentInstructions(session_id, {
          origin: "agent",
          ops: [{ op: "update", id: instruction_id, ...(text === undefined ? {} : { text }), ...(status === undefined ? {} : { status }) }],
        });
        const outcome = result.results[0]!;
        if (outcome.status === "not_found") {
          return withFirstLine({ session_id, instruction_id, status: outcome.status }, "지시를 찾지 못했습니다.");
        }
        if (outcome.status === "cap_reached") {
          return withFirstLine({ session_id, instruction_id, status: outcome.status }, "활성 지속 지시 상한에 도달했습니다.");
        }
        return withFirstLine({ session_id, status: outcome.status, instruction: outcome.item }, outcome.item?.text ?? "지시가 갱신되었습니다.");
      } catch (err) {
        return errorResultFromError(err);
      }
    },
  );
}

function withFirstLine(value: Record<string, unknown>, firstLine: string) {
  const result = jsonResult(value);
  return {
    ...result,
    content: [{ type: "text" as const, text: `${firstLine}\n${result.content[0]?.text ?? ""}` }],
  };
}
