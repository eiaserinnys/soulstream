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
      description: "퍼시스턴트 세션의 다음 실행에서 새 세대(새 모델 세션)로 교체하도록 요청한다. 기본은 이전 세대의 체크포인트를 이어 받는다. reset_context=true면 체크포인트를 현재 상태와 keep_instructions 설정에 따른 지속 지시만으로 다시 구성해 이전 대화 문맥을 비운다.",
      inputSchema: {
        session_id: z.string().min(1),
        model_preset: z.string().min(1).optional(),
        reasoning_effort: z.enum(MODEL_REASONING_EFFORTS).optional(),
        reason: z.string().optional(),
        reset_context: z.boolean().optional().describe("true면 새 세대 체크포인트에서 이전 줄거리, 요약, 최근 원문을 제외한다. 현재 상태는 포함하며 지속 지시는 keep_instructions 값에 따른다. 기본 false."),
        keep_instructions: z.boolean().optional().describe("reset_context=true일 때만 사용한다. false면 해당 세대 체크포인트에서 지속 지시를 빼며 저장된 지시는 삭제하지 않는다. 기본 true."),
      },
    },
    async ({ session_id, model_preset, reasoning_effort, reason, reset_context, keep_instructions }) => {
      try {
        const result = await runtime.taskManager.persistentSessions
          .requestGenerationRollover(session_id, {
            modelPreset: model_preset,
            reasoningEffort: reasoning_effort,
            reason: reason ?? "manual",
            resetContext: reset_context ?? false,
            keepInstructions: keep_instructions ?? true,
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
