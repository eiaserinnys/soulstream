import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  attachmentTools,
  attachSessionOutputInputSchema,
  errorResult,
  jsonResult,
  registerAttachmentInputSchema,
  resolveAttachmentInputSchema,
} from "@soulstream/mcp-contract";
import { z } from "zod";
import { getCurrentMcpCallerSessionId } from "../request_context.js";
import type { McpRuntime } from "../runtime.js";
import { publishSessionOutputAttachment } from "../../attachments/session_output_attachment.js";
import { resolveProducedAttachmentExecutionContext } from "../../attachments/produced_attachment_context.js";
import { requireMcpMutationActor } from "./caller_session.js";

export function registerAttachmentTools(server: McpServer, runtime: McpRuntime): void {
  const definition = attachmentTools.register_attachment;
  server.registerTool(definition.name, {
    ...definition.config,
    description: `${definition.config.description}\n채팅 답변에 보이려면 이 도구가 돌려준 ID를 attach_session_output에 명시적으로 전달하세요.`,
    inputSchema: z.object(definition.config.inputSchema).strict(),
  }, async (input, extra) => {
    const sessionId = getCurrentMcpCallerSessionId();
    if (!sessionId) return errorResult("ATTACHMENT_UNAUTHENTICATED: 호출 세션 정보를 찾을 수 없습니다.");
    try {
      requireMcpMutationActor(undefined, definition.name);
    } catch (error) {
      return errorResult(`ATTACHMENT_UNAUTHENTICATED: ${errorMessage(error)}`);
    }

    const task = runtime.taskManager.getTask(sessionId);
    const execution = resolveProducedAttachmentExecutionContext(
      task,
      sessionId,
      runtime.nodeId,
    );
    if (!execution) {
      return errorResult("ATTACHMENT_ACTIVE_EXECUTION_REQUIRED: 현재 실행의 출력 파일만 등록할 수 있습니다.");
    }

    const service = runtime.producedAttachments;
    if (!service) {
      return errorResult("ATTACHMENT_REGISTRATION_UNAVAILABLE: 첨부 등록 서비스를 사용할 수 없습니다.");
    }

    try {
      const parsedInput = registerAttachmentInputSchema.parse(input);
      const result = await service.register(parsedInput, execution, extra.signal);
      return jsonResult(result);
    } catch (error) {
      const code = errorCode(error);
      return errorResult(`${code ? `${code}: ` : ""}${errorMessage(error)}`);
    }
  });

  const outputDefinition = attachmentTools.attach_session_output;
  server.registerTool(outputDefinition.name, {
    ...outputDefinition.config,
    inputSchema: z.object(outputDefinition.config.inputSchema).strict(),
  }, async (input, extra) => {
    const sessionId = getCurrentMcpCallerSessionId();
    if (!sessionId) return errorResult("ATTACHMENT_UNAUTHENTICATED: 호출 세션 정보를 찾을 수 없습니다.");
    try {
      requireMcpMutationActor(undefined, outputDefinition.name);
    } catch (error) {
      return errorResult(`ATTACHMENT_UNAUTHENTICATED: ${errorMessage(error)}`);
    }

    try {
      const parsedInput = attachSessionOutputInputSchema.parse(input);
      const attachmentIds = [...new Set(parsedInput.attachment_ids)];
      const task = runtime.taskManager.getTask(sessionId);
      const outputCommandId = task?.runner?.dispatcher.activeExecutionCommandId?.();
      const registrationId = task?.executionRegistration?.registrationId;
      if (
        !task ||
        typeof outputCommandId !== "string" ||
        !outputCommandId.trim() ||
        typeof registrationId !== "string" ||
        !registrationId.trim()
      ) {
        return errorResult("ATTACHMENT_ACTIVE_EXECUTION_REQUIRED: 현재 실행에 첨부를 연결할 수 없습니다.");
      }

      const service = runtime.producedAttachments;
      if (!service?.validateSessionOutput) {
        return errorResult("ATTACHMENT_REGISTRATION_UNAVAILABLE: 첨부 검증 서비스를 사용할 수 없습니다.");
      }
      const publisher = runtime.chatUiPublisher;
      if (!publisher) {
        return errorResult("ATTACHMENT_REGISTRATION_UNAVAILABLE: 첨부 응답 발행기를 사용할 수 없습니다.");
      }

      const validation = await service.validateSessionOutput({ attachment_ids: attachmentIds }, {
        sessionId,
        nodeId: runtime.nodeId,
        outputCommandId,
      }, extra.signal);
      if (!sameStringArray(validation.attachment_ids, attachmentIds)) {
        return errorResult("ATTACHMENT_REGISTRATION_UNAVAILABLE: 첨부 검증 응답이 요청과 일치하지 않습니다.");
      }

      if (
        task.runner?.dispatcher.activeExecutionCommandId?.() !== outputCommandId ||
        task.executionRegistration?.registrationId !== registrationId
      ) {
        return errorResult("ATTACHMENT_OUTPUT_EXECUTION_CHANGED: 검증 중 실행이 바뀌어 첨부를 연결하지 않았습니다.");
      }

      return jsonResult(await publishSessionOutputAttachment({
        sessionId,
        outputCommandId,
        registrationId,
        attachmentIds,
        publisher,
      }));
    } catch (error) {
      const code = errorCode(error);
      return errorResult(`${code ? `${code}: ` : ""}${errorMessage(error)}`);
    }
  });

  const resolveDefinition = attachmentTools.resolve_attachment;
  server.registerTool(resolveDefinition.name, {
    ...resolveDefinition.config,
    inputSchema: z.object(resolveDefinition.config.inputSchema).strict(),
  }, async (input, extra) => {
    try {
      const parsedInput = resolveAttachmentInputSchema.parse(input);
      const sessionId = getCurrentMcpCallerSessionId();
      if (!sessionId) return errorResult("ATTACHMENT_UNAUTHENTICATED: 호출 세션 정보를 찾을 수 없습니다.");

      const task = runtime.taskManager.getTask(sessionId);
      if (!task) return errorResult("SESSION_NOT_FOUND: 호출 세션을 찾을 수 없습니다.");

      const materializer = runtime.attachmentMaterializer;
      if (!materializer) return errorResult("ATTACHMENT_INPUT_UNAVAILABLE: 첨부 준비 서비스를 사용할 수 없습니다.");

      const result = await materializer.materialize({
        sessionId,
        attachmentId: parsedInput.attachment_id,
        mode: "resolve",
      }, extra.signal);
      return jsonResult(result);
    } catch (error) {
      const code = errorCode(error);
      return errorResult(`${code ? `${code}: ` : ""}${errorMessage(error)}`);
    }
  });
}

function sameStringArray(left: unknown, right: readonly string[]): left is string[] {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
