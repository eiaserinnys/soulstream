import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { TaskItemStatus } from "../../db/session_db_types.js";
import type { McpRuntime } from "../runtime.js";

import {
  assigneePatch,
  assigneeSchema,
  assigneeValueSchema,
  callerSessionIdSchema,
  expectedVersionSchema,
  idempotencyKeySchema,
  mutation,
  mutationResponseInputSchema,
  mutationToolDescription,
  optionalReasonSchema,
  taskItemStatusSchema,
} from "./task_shared.js";

export function registerTaskItemTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "create_task_item",
    {
      description: mutationToolDescription(
        "현재 MCP caller session을 actor_kind='agent'로 하여 업무 아이템을 생성한다.",
      ),
      inputSchema: {
        ...mutationResponseInputSchema,
        task_id: z.string().min(1),
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
      mutation(
        runtime,
        input.caller_session_id,
        (service, actorSessionId) =>
          service.createItem({
            actorKind: "agent",
            actorSessionId,
            taskId: input.task_id,
            sectionId: input.section_id,
            title: input.title,
            howTo: input.how_to,
            itemId: input.item_id,
            afterItemId: input.after_item_id,
            beforeItemId: input.before_item_id,
            idempotencyKey: input.idempotency_key,
            ...assigneePatch(input),
          }),
        { targetKind: "item", includeSnapshot: input.include_snapshot },
      ),
  );

  server.registerTool(
    "update_task_item",
    {
      description: mutationToolDescription(
        "현재 MCP caller session을 actor_kind='agent'로 하여 업무 아이템 제목 또는 본문을 수정한다.",
      ),
      inputSchema: {
        ...mutationResponseInputSchema,
        task_id: z.string().min(1),
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
      mutation(
        runtime,
        input.caller_session_id,
        (service, actorSessionId) =>
          service.patchItem({
            actorKind: "agent",
            actorSessionId,
            taskId: input.task_id,
            itemId: input.item_id,
            expectedVersion: input.expected_version,
            title: input.title,
            howTo: input.how_to,
            reason: input.reason,
            idempotencyKey: input.idempotency_key,
          }),
        { targetKind: "item", includeSnapshot: input.include_snapshot },
      ),
  );

  server.registerTool(
    "set_task_item_assignee",
    {
      description: mutationToolDescription(
        "현재 MCP caller session을 actor_kind='agent'로 하여 업무 아이템 담당자를 설정하거나 해제한다.",
      ),
      inputSchema: {
        ...mutationResponseInputSchema,
        task_id: z.string().min(1),
        item_id: z.string().min(1),
        expected_version: expectedVersionSchema,
        assignee: assigneeValueSchema,
        reason: optionalReasonSchema,
        idempotency_key: idempotencyKeySchema,
        caller_session_id: callerSessionIdSchema,
      },
    },
    async (input) =>
      mutation(
        runtime,
        input.caller_session_id,
        (service, actorSessionId) =>
          service.setItemAssignee({
            actorKind: "agent",
            actorSessionId,
            taskId: input.task_id,
            itemId: input.item_id,
            expectedVersion: input.expected_version,
            reason: input.reason,
            idempotencyKey: input.idempotency_key,
            ...assigneePatch(input),
          }),
        { targetKind: "item", includeSnapshot: input.include_snapshot },
      ),
  );

  registerItemArchiveTool(server, runtime, {
    name: "archive_task_item",
    archived: true,
    description:
      "현재 MCP caller session을 actor_kind='agent'로 하여 업무 아이템을 archived 처리한다.",
  });
  registerItemArchiveTool(server, runtime, {
    name: "unarchive_task_item",
    archived: false,
    description:
      "현재 MCP caller session을 actor_kind='agent'로 하여 archived 업무 아이템을 복구한다.",
  });

  server.registerTool(
    "move_task_item",
    {
      description: mutationToolDescription(
        "현재 MCP caller session을 actor_kind='agent'로 하여 업무 아이템을 다른 위치나 섹션으로 이동한다.",
      ),
      inputSchema: {
        ...mutationResponseInputSchema,
        task_id: z.string().min(1),
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
      mutation(
        runtime,
        input.caller_session_id,
        (service, actorSessionId) =>
          service.moveItem({
            actorKind: "agent",
            actorSessionId,
            taskId: input.task_id,
            itemId: input.item_id,
            expectedVersion: input.expected_version,
            sectionId: input.section_id,
            afterItemId: input.after_item_id,
            beforeItemId: input.before_item_id,
            reason: input.reason,
            idempotencyKey: input.idempotency_key,
          }),
        { targetKind: "item", includeSnapshot: input.include_snapshot },
      ),
  );

  server.registerTool(
    "set_task_item_status",
    {
      description: mutationToolDescription(
        "현재 MCP caller session을 actor_kind='agent'로 하여 업무 아이템 상태를 설정한다.",
      ),
      inputSchema: {
        ...mutationResponseInputSchema,
        item_id: z.string().min(1),
        status: taskItemStatusSchema,
        expected_version: expectedVersionSchema,
        reason: optionalReasonSchema,
        idempotency_key: idempotencyKeySchema,
        caller_session_id: callerSessionIdSchema,
      },
    },
    async (input) =>
      mutation(
        runtime,
        input.caller_session_id,
        (service, actorSessionId) =>
          service.setItemStatus({
            actorKind: "agent",
            actorSessionId,
            itemId: input.item_id,
            status: input.status as TaskItemStatus,
            expectedVersion: input.expected_version,
            reason: input.reason,
            idempotencyKey: input.idempotency_key,
          }),
        { targetKind: "item", includeSnapshot: input.include_snapshot },
      ),
  );
}

function registerItemArchiveTool(
  server: McpServer,
  runtime: McpRuntime,
  config: {
    name: "archive_task_item" | "unarchive_task_item";
    archived: boolean;
    description: string;
  },
): void {
  server.registerTool(
    config.name,
    {
      description: mutationToolDescription(config.description),
      inputSchema: {
        ...mutationResponseInputSchema,
        task_id: z.string().min(1),
        item_id: z.string().min(1),
        expected_version: expectedVersionSchema,
        reason: optionalReasonSchema,
        idempotency_key: idempotencyKeySchema,
        caller_session_id: callerSessionIdSchema,
      },
    },
    async (input) =>
      mutation(
        runtime,
        input.caller_session_id,
        (service, actorSessionId) =>
          service.patchItem({
            actorKind: "agent",
            actorSessionId,
            taskId: input.task_id,
            itemId: input.item_id,
            expectedVersion: input.expected_version,
            archived: config.archived,
            reason: input.reason,
            idempotencyKey: input.idempotency_key,
          }),
        { targetKind: "item", includeSnapshot: input.include_snapshot },
      ),
  );
}
