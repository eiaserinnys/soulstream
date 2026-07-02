import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RunbookStatus } from "../../db/session_db_types.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";

import {
  errorMessage,
  expectedVersionSchema,
  getRunbookService,
  idempotencyKeySchema,
  mutation,
  optionalReasonSchema,
  runbookStatusSchema,
} from "./runbook_shared.js";

export function registerRunbookObjectTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "create_runbook",
    {
      description:
        "현재 MCP caller session을 actor_kind='agent'로 하여 독립 runbook board item과 런북을 생성한다.",
      inputSchema: {
        folder_id: z.string().min(1),
        title: z.string().default(""),
        x: z.number().optional(),
        y: z.number().optional(),
        runbook_id: z.string().min(1).optional(),
        idempotency_key: idempotencyKeySchema,
      },
    },
    async (input) =>
      mutation(runtime, (service, actorSessionId) =>
        service.createRunbook({
          actorKind: "agent",
          actorSessionId,
          folderId: input.folder_id,
          title: input.title,
          x: input.x,
          y: input.y,
          runbookId: input.runbook_id,
          idempotencyKey: input.idempotency_key,
        }),
      ),
  );

  server.registerTool(
    "list_runbooks",
    {
      description: "지정한 폴더의 runbook board item 목록을 조회한다.",
      inputSchema: {
        folder_id: z.string().min(1),
        include_archived: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    async ({ folder_id, include_archived, limit }) => {
      try {
        return jsonResult(
          await getRunbookService(runtime).listRunbooks({
            folderId: folder_id,
            includeArchived: include_archived,
            limit,
          }),
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "update_runbook",
    {
      description:
        "현재 MCP caller session을 actor_kind='agent'로 하여 런북 제목을 수정한다.",
      inputSchema: {
        runbook_id: z.string().min(1),
        expected_version: expectedVersionSchema,
        title: z.string().min(1),
        reason: optionalReasonSchema,
        idempotency_key: idempotencyKeySchema,
      },
    },
    async (input) =>
      mutation(runtime, (service, actorSessionId) =>
        service.patchRunbook({
          actorKind: "agent",
          actorSessionId,
          runbookId: input.runbook_id,
          expectedVersion: input.expected_version,
          title: input.title,
          reason: input.reason,
          idempotencyKey: input.idempotency_key,
        }),
      ),
  );

  registerRunbookArchiveTool(server, runtime, {
    name: "archive_runbook",
    archived: true,
    description:
      "현재 MCP caller session을 actor_kind='agent'로 하여 런북을 archived 처리한다.",
  });
  registerRunbookArchiveTool(server, runtime, {
    name: "unarchive_runbook",
    archived: false,
    description:
      "현재 MCP caller session을 actor_kind='agent'로 하여 archived 런북을 복구한다.",
  });

  server.registerTool(
    "set_runbook_status",
    {
      description:
        "현재 MCP caller session을 actor_kind='agent'로 하여 런북 자체의 open/completed 상태를 설정한다.",
      inputSchema: {
        runbook_id: z.string().min(1),
        status: runbookStatusSchema,
        expected_version: expectedVersionSchema,
        reason: optionalReasonSchema,
        idempotency_key: idempotencyKeySchema,
      },
    },
    async (input) =>
      mutation(runtime, (service, actorSessionId) =>
        service.setRunbookStatus({
          actorKind: "agent",
          actorSessionId,
          runbookId: input.runbook_id,
          status: input.status as RunbookStatus,
          expectedVersion: input.expected_version,
          reason: input.reason,
          idempotencyKey: input.idempotency_key,
        }),
      ),
  );

  server.registerTool(
    "get_runbook",
    {
      description: "런북 snapshot을 조회한다.",
      inputSchema: { runbook_id: z.string().min(1) },
    },
    async ({ runbook_id }) => {
      try {
        return jsonResult(await getRunbookService(runtime).getRunbook(runbook_id));
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "list_my_turn_items",
    {
      description:
        "사람 처리 차례인 런북 아이템을 조회한다. MCP 경로는 user 귀속을 시도하지 않는다.",
      inputSchema: { limit: z.number().int().min(1).max(500).default(100) },
    },
    async ({ limit }) => {
      try {
        return jsonResult(
          await getRunbookService(runtime).listMyTurnItems({ limit }),
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "list_runbook_operations",
    {
      description: "런북 append-only operation 이력을 최신순으로 조회한다.",
      inputSchema: {
        runbook_id: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    async ({ runbook_id, limit }) => {
      try {
        return jsonResult(
          await getRunbookService(runtime).listOperations(runbook_id, limit),
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );
}

function registerRunbookArchiveTool(
  server: McpServer,
  runtime: McpRuntime,
  config: { name: "archive_runbook" | "unarchive_runbook"; archived: boolean; description: string },
): void {
  server.registerTool(
    config.name,
    {
      description: config.description,
      inputSchema: {
        runbook_id: z.string().min(1),
        expected_version: expectedVersionSchema,
        reason: optionalReasonSchema,
        idempotency_key: idempotencyKeySchema,
      },
    },
    async (input) =>
      mutation(runtime, (service, actorSessionId) =>
        service.patchRunbook({
          actorKind: "agent",
          actorSessionId,
          runbookId: input.runbook_id,
          expectedVersion: input.expected_version,
          archived: config.archived,
          reason: input.reason,
          idempotencyKey: input.idempotency_key,
        }),
      ),
  );
}
