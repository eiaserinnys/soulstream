import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import { errorMessage, getTaskService } from "./task_shared.js";
import { formatTaskReadResponse } from "./task_response.js";

/** Remove in Phase 3. These are the only legacy MCP names kept for one release. */
export function registerTaskLegacyReadCompatibility(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "get_runbook",
    {
      description: "Deprecated read-only alias for get_task. Remove in Phase 3.",
      inputSchema: {
        runbook_id: z.string().min(1),
        view: z.enum(["full", "outline"]).default("full"),
        item_id: z.string().min(1).optional(),
      },
    },
    async ({ runbook_id, view, item_id }) => {
      try {
        const snapshot = await getTaskService(runtime).getTask(runbook_id);
        return jsonResult(
          legacyReadShape(
            formatTaskReadResponse(snapshot, { view, itemId: item_id }),
          ),
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    },
  );

  server.registerTool(
    "list_runbooks",
    {
      description: "Deprecated read-only alias for list_tasks. Remove in Phase 3.",
      inputSchema: {
        folder_id: z.string().min(1),
        include_archived: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    async ({ folder_id, include_archived, limit }) => {
      try {
        return jsonResult(
          legacyReadShape(
            await getTaskService(runtime).listTasks({
              folderId: folder_id,
              includeArchived: include_archived,
              limit,
            }),
          ),
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    },
  );

  server.registerTool(
    "list_runbook_operations",
    {
      description:
        "Deprecated read-only alias for list_task_operations. Remove in Phase 3.",
      inputSchema: {
        runbook_id: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    async ({ runbook_id, limit }) => {
      try {
        return jsonResult(
          legacyReadShape(
            await getTaskService(runtime).listOperations(runbook_id, limit),
          ),
        );
      } catch (error) {
        return errorResult(errorMessage(error));
      }
    },
  );
}

function legacyReadShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(legacyReadShape);
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const legacyKey = legacyKeyFor(key);
    output[legacyKey] = legacyValueFor(legacyKey, legacyReadShape(entry));
  }
  return output;
}

function legacyKeyFor(key: string): string {
  if (key === "task") return "runbook";
  if (key === "tasks") return "runbooks";
  if (key === "task_id") return "runbook_id";
  if (key === "taskId") return "runbookId";
  if (key === "task_status") return "runbook_status";
  return key;
}

function legacyValueFor(key: string, value: unknown): unknown {
  if (key === "target_kind" && value === "task") return "runbook";
  if (key === "operation_type" && typeof value === "string") {
    return value.replaceAll("task", "runbook");
  }
  return value;
}
