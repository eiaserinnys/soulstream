import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorResult, skillTools } from "@soulstream/mcp-contract";
import { z } from "zod";
import { resolveProducedAttachmentExecutionContext } from "../../attachments/produced_attachment_context.js";
import { forwardOrchestratorTool, registerOrchestratorTools } from "../orchestrator_tools.js";
import { getCurrentMcpCallerSessionId } from "../request_context.js";
import type { McpRuntime } from "../runtime.js";
import { requireMcpMutationActor } from "./caller_session.js";
import { readSkillLintReportFile, SkillLintReportFileError } from "./skill_lint_report_file.js";

export function registerSkillsTools(server: McpServer, runtime: McpRuntime): void {
  registerOrchestratorTools(
    server,
    runtime,
    Object.values(skillTools).filter((definition) => definition.name !== "put_skill_lint_report"),
  );

  // 파일을 이 노드에서 읽어 {report}로 orch에 넘긴다. orch가 파일 경로를 알 수 없어서다.
  const definition = skillTools.put_skill_lint_report;
  server.registerTool(definition.name, {
    ...definition.config,
    inputSchema: z.object(definition.config.inputSchema).strict(),
  }, async (input, extra) => {
    const sessionId = getCurrentMcpCallerSessionId();
    if (!sessionId) return errorResult("SKILL_LINT_REPORT_UNAUTHENTICATED: 호출 세션 정보를 찾을 수 없습니다.");
    try {
      requireMcpMutationActor(undefined, definition.name);
      const execution = resolveProducedAttachmentExecutionContext(
        runtime.taskManager.getTask(sessionId), sessionId, runtime.nodeId,
      );
      if (!execution) {
        return errorResult("SKILL_LINT_REPORT_ACTIVE_EXECUTION_REQUIRED: 현재 실행의 작업 폴더를 찾을 수 없습니다.");
      }
      const report = await readSkillLintReportFile(String(input.report_file), execution);
      return await forwardOrchestratorTool(runtime, definition, { report }, undefined, extra.signal);
    } catch (error) {
      const code = error instanceof SkillLintReportFileError ? `${error.code}: ` : "";
      return errorResult(`${code}${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
