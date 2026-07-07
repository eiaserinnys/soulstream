import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RunbookItemStatus } from "../../db/session_db_types.js";
import type { McpRuntime } from "../runtime.js";

import {
  assigneePatch,
  assigneeSchema,
  assigneeValueSchema,
  callerSessionIdSchema,
  expectedVersionSchema,
  idempotencyKeySchema,
  mutation,
  mutationToolDescription,
  optionalReasonSchema,
  runbookItemStatusSchema,
} from "./runbook_shared.js";

export function registerRunbookItemTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "create_runbook_item",
    {
      description: mutationToolDescription(
        "현재 MCP caller session을 actor_kind='agent'로 하여 런북 아이템을 생성한다.",
      ),
      inputSchema: {
        runbook_id: z.string().min(1),
        section_id: z.string().min(1),
        title: z.string().min(1),
        how_to: z.string().default(""),
        item_id: z.string().min(1).optional(),
        assignee: assigneeSchema,
        after_item_id: z.string().nullable().optional(),
        before_item_id: z.string().nullable().optional(),
        idempotency_key: idempotencyKeySchema,
        caller_session_id: callerSessionIdSchema,
      },
    },
    async (input) =>
      mutation(runtime, input.caller_session_id, (service, actorSessionId) =>
        service.createItem({
          actorKind: "agent",
          actorSessionId,
          runbookId: input.runbook_id,
          sectionId: input.section_id,
          title: input.title,
          howTo: input.how_to,
          itemId: input.item_id,
          afterItemId: input.after_item_id,
          beforeItemId: input.before_item_id,
          idempotencyKey: input.idempotency_key,
          ...assigneePatch(input),
        }),
      ),
  );

  server.registerTool(
    "update_runbook_item",
    {
      description: mutationToolDescription(
        "현재 MCP caller session을 actor_kind='agent'로 하여 런북 아이템 제목 또는 본문을 수정한다.",
      ),
      inputSchema: {
        runbook_id: z.string().min(1),
        item_id: z.string().min(1),
        expected_version: expectedVersionSchema,
        title: z.string().min(1).optional(),
        how_to: z.string().optional(),
        reason: optionalReasonSchema,
        idempotency_key: idempotencyKeySchema,
        caller_session_id: callerSessionIdSchema,
      },
    },
    async (input) =>
      mutation(runtime, input.caller_session_id, (service, actorSessionId) =>
        service.patchItem({
          actorKind: "agent",
          actorSessionId,
          runbookId: input.runbook_id,
          itemId: input.item_id,
          expectedVersion: input.expected_version,
          title: input.title,
          howTo: input.how_to,
          reason: input.reason,
          idempotencyKey: input.idempotency_key,
        }),
      ),
  );

  server.registerTool(
    "set_runbook_item_assignee",
    {
      description: mutationToolDescription(
        "현재 MCP caller session을 actor_kind='agent'로 하여 런북 아이템 담당자를 설정하거나 해제한다.",
      ),
      inputSchema: {
        runbook_id: z.string().min(1),
        item_id: z.string().min(1),
        expected_version: expectedVersionSchema,
        assignee: assigneeValueSchema,
        reason: optionalReasonSchema,
        idempotency_key: idempotencyKeySchema,
        caller_session_id: callerSessionIdSchema,
      },
    },
    async (input) =>
      mutation(runtime, input.caller_session_id, (service, actorSessionId) =>
        service.setItemAssignee({
          actorKind: "agent",
          actorSessionId,
          runbookId: input.runbook_id,
          itemId: input.item_id,
          expectedVersion: input.expected_version,
          reason: input.reason,
          idempotencyKey: input.idempotency_key,
          ...assigneePatch(input),
        }),
      ),
  );

  registerItemArchiveTool(server, runtime, {
    name: "archive_runbook_item",
    archived: true,
    description: "현재 MCP caller session을 actor_kind='agent'로 하여 런북 아이템을 archived 처리한다.",
  });
  registerItemArchiveTool(server, runtime, {
    name: "unarchive_runbook_item",
    archived: false,
    description: "현재 MCP caller session을 actor_kind='agent'로 하여 archived 런북 아이템을 복구한다.",
  });

  server.registerTool(
    "move_runbook_item",
    {
      description: mutationToolDescription(
        "현재 MCP caller session을 actor_kind='agent'로 하여 런북 아이템을 다른 위치나 섹션으로 이동한다.",
      ),
      inputSchema: {
        runbook_id: z.string().min(1),
        item_id: z.string().min(1),
        expected_version: expectedVersionSchema,
        section_id: z.string().nullable().optional(),
        after_item_id: z.string().nullable().optional(),
        before_item_id: z.string().nullable().optional(),
        reason: optionalReasonSchema,
        idempotency_key: idempotencyKeySchema,
        caller_session_id: callerSessionIdSchema,
      },
    },
    async (input) =>
      mutation(runtime, input.caller_session_id, (service, actorSessionId) =>
        service.moveItem({
          actorKind: "agent",
          actorSessionId,
          runbookId: input.runbook_id,
          itemId: input.item_id,
          expectedVersion: input.expected_version,
          sectionId: input.section_id,
          afterItemId: input.after_item_id,
          beforeItemId: input.before_item_id,
          reason: input.reason,
          idempotencyKey: input.idempotency_key,
        }),
      ),
  );

  server.registerTool(
    "set_runbook_item_status",
    {
      description: mutationToolDescription(
        "현재 MCP caller session을 actor_kind='agent'로 하여 런북 아이템 상태를 설정한다.",
      ),
      inputSchema: {
        item_id: z.string().min(1),
        status: runbookItemStatusSchema,
        expected_version: expectedVersionSchema,
        reason: optionalReasonSchema,
        idempotency_key: idempotencyKeySchema,
        caller_session_id: callerSessionIdSchema,
      },
    },
    async (input) =>
      mutation(runtime, input.caller_session_id, (service, actorSessionId) =>
        service.setItemStatus({
          actorKind: "agent",
          actorSessionId,
          itemId: input.item_id,
          status: input.status as RunbookItemStatus,
          expectedVersion: input.expected_version,
          reason: input.reason,
          idempotencyKey: input.idempotency_key,
        }),
      ),
  );
}

function registerItemArchiveTool(
  server: McpServer,
  runtime: McpRuntime,
  config: {
    name: "archive_runbook_item" | "unarchive_runbook_item";
    archived: boolean;
    description: string;
  },
): void {
  server.registerTool(
    config.name,
    {
      description: mutationToolDescription(config.description),
      inputSchema: {
        runbook_id: z.string().min(1),
        item_id: z.string().min(1),
        expected_version: expectedVersionSchema,
        reason: optionalReasonSchema,
        idempotency_key: idempotencyKeySchema,
        caller_session_id: callerSessionIdSchema,
      },
    },
    async (input) =>
      mutation(runtime, input.caller_session_id, (service, actorSessionId) =>
        service.patchItem({
          actorKind: "agent",
          actorSessionId,
          runbookId: input.runbook_id,
          itemId: input.item_id,
          expectedVersion: input.expected_version,
          archived: config.archived,
          reason: input.reason,
          idempotencyKey: input.idempotency_key,
        }),
      ),
  );
}
