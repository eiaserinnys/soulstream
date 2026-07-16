import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  TASK_STATUSES,
} from "../../task_tree/task_tree_repository.js";
import type { TaskTreeService } from "../../task_tree/task_tree_service.js";
import { errorResult, jsonResult, paginatedArrayResult } from "../result.js";

const taskStatusSchema = z.enum(TASK_STATUSES);

export function registerTaskTreeQueryTools(
  server: McpServer,
  getService: () => TaskTreeService,
): void {
  server.registerTool(
    "get_task_context",
    {
      description:
        "세션의 active task, path, linked tasks를 조회한다. 컴팩션/resume 후 parent task 복구에 사용한다.",
      inputSchema: { session_id: z.string() },
    },
    async ({ session_id }) => {
      try {
        return jsonResult(await getService().getTaskContext(session_id));
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "search_task_items",
    {
      description:
        "Task Tree item을 검색하거나 root/linked session 기준으로 path와 함께 조회한다. 기본 20건이며 total/truncated를 함께 반환한다.",
      inputSchema: {
        query: z.string().optional(),
        status: taskStatusSchema.optional(),
        root_task_id: z.string().optional(),
        linked_session_id: z.string().optional(),
        include_archived: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(20),
      },
    },
    async (input) => {
      try {
        const { items, total } = await getService().searchTaskItemsPage({
          query: input.query,
          status: input.status,
          rootTaskId: input.root_task_id,
          linkedSessionId: input.linked_session_id,
          includeArchived: input.include_archived,
          limit: input.limit,
        });
        const truncated = items.length < total;
        return paginatedArrayResult(
          items,
          {
            total,
            returned: items.length,
            limit: input.limit,
            truncated,
          },
          truncated
            ? `${total}건 중 ${items.length}건 표시. limit을 늘리거나 검색 조건을 좁혀 계속 조회하세요.`
            : undefined,
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "list_task_operations",
    {
      description:
        "Task item의 append-only operation 이력을 최신순으로 조회한다. 기본 20건이며 offset으로 계속 조회한다.",
      inputSchema: {
        task_id: z.string(),
        limit: z.number().int().min(1).max(200).default(20),
        offset: z.number().int().min(0).default(0),
      },
    },
    async ({ task_id, limit, offset }) => {
      try {
        const { operations, total } = await getService().listOperationsPage(
          task_id,
          { limit, offset },
        );
        const nextOffset = offset + operations.length;
        const truncated = nextOffset < total;
        return paginatedArrayResult(
          operations,
          {
            total,
            returned: operations.length,
            limit,
            offset,
            truncated,
            next_offset: truncated ? nextOffset : null,
          },
          truncated
            ? `${total}건 중 offset ${offset}부터 ${operations.length}건 표시. offset=${nextOffset}로 계속 조회하세요.`
            : undefined,
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
