import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";

export function registerClaudeRuntimeTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "list_claude_background_tasks",
    {
      description: "Claude Agent SDK background task 목록을 조회한다.",
      inputSchema: {
        session_id: z.string(),
      },
    },
    async ({ session_id }) => {
      try {
        return jsonResult(await runtime.taskManager.listClaudeRuntimeTasks(session_id));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "get_claude_background_task_output",
    {
      description: "Claude Agent SDK background task 출력 또는 요약을 조회한다.",
      inputSchema: {
        session_id: z.string(),
        task_id: z.string(),
      },
    },
    async ({ session_id, task_id }) => {
      try {
        return jsonResult(
          await runtime.taskManager.getClaudeRuntimeTaskOutput(session_id, task_id),
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "stop_claude_background_task",
    {
      description: "Claude Agent SDK background task를 중단한다.",
      inputSchema: {
        session_id: z.string(),
        task_id: z.string(),
      },
    },
    async ({ session_id, task_id }) => {
      try {
        return jsonResult(await runtime.taskManager.stopClaudeRuntimeTask(session_id, task_id));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "background_claude_tasks",
    {
      description: "Claude SDK Query.backgroundTasks(toolUseId)를 호출한다.",
      inputSchema: {
        session_id: z.string(),
        tool_use_id: z.string().optional(),
      },
    },
    async ({ session_id, tool_use_id }) => {
      try {
        return jsonResult(
          await runtime.taskManager.backgroundClaudeRuntimeTasks(session_id, tool_use_id),
        );
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
