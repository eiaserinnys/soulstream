import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { errorResultFromError, jsonResult } from "../result.js";
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
}
