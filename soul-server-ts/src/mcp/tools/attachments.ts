import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  attachmentTools,
  errorResult,
  jsonResult,
  registerAttachmentInputSchema,
  resolveAttachmentInputSchema,
} from "@soulstream/mcp-contract";
import { z } from "zod";
import { getCurrentMcpCallerSessionId } from "../request_context.js";
import type { McpRuntime } from "../runtime.js";
import { requireMcpMutationActor } from "./caller_session.js";

export function registerAttachmentTools(server: McpServer, runtime: McpRuntime): void {
  const definition = attachmentTools.register_attachment;
  server.registerTool(definition.name, {
    ...definition.config,
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
    // Only worktree executions set resolvedWorkspaceDir; a plain session runs in
    // its engine's workspace (same order as listActiveTaskWorkspaceDirs).
    const workspaceDir = task?.resolvedWorkspaceDir ?? task?.runner?.engine.workspaceDir;
    const outputCommandId = task?.runner?.dispatcher.activeExecutionCommandId?.();
    if (
      !task ||
      typeof workspaceDir !== "string" ||
      !workspaceDir.trim() ||
      typeof outputCommandId !== "string" ||
      !outputCommandId.trim()
    ) {
      return errorResult("ATTACHMENT_ACTIVE_EXECUTION_REQUIRED: 현재 실행의 출력 파일만 등록할 수 있습니다.");
    }

    const service = runtime.producedAttachments;
    if (!service) {
      return errorResult("ATTACHMENT_REGISTRATION_UNAVAILABLE: 첨부 등록 서비스를 사용할 수 없습니다.");
    }

    try {
      const parsedInput = registerAttachmentInputSchema.parse(input);
      const result = await service.register(parsedInput, {
        sessionId,
        nodeId: runtime.nodeId,
        outputCommandId,
        workspaceDir,
        profileWorkspaceDir: task.agentProfileSnapshot?.workspace_dir,
      }, extra.signal);
      return jsonResult(result);
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

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
