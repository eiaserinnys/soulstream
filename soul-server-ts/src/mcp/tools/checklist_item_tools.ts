import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ChecklistItemStatus } from "../../db/session_db_types.js";
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
  checklistItemStatusSchema,
} from "./folder_tool_shared.js";

export function registerChecklistItemTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "create_checklist_item",
    {
      description: mutationToolDescription(
        "현재 MCP caller session을 actor_kind='agent'로 하여 체크리스트 항목을 생성한다.",
      ),
      inputSchema: {
        folder_id: z.string().min(1),
        section_id: z.string().min(1),
        title: z.string().min(1),
        how_to: z.string().default(""),
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
        (service, actor) =>
          service.createChecklistItem({
            ...actor,
            folderId: input.folder_id,
            sectionId: input.section_id,
            title: input.title,
            howTo: input.how_to,
            afterItemId: input.after_item_id,
            beforeItemId: input.before_item_id,
            idempotencyKey: input.idempotency_key,
            ...assigneePatch(input),
          }),
      ),
  );

  server.registerTool(
    "update_checklist_item",
    {
      description: mutationToolDescription(
        "현재 MCP caller session을 actor_kind='agent'로 하여 체크리스트 항목 제목 또는 본문을 수정한다.",
      ),
      inputSchema: {
        folder_id: z.string().min(1),
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
        (service, actor) =>
          service.updateChecklistItem({
            ...actor,
            folderId: input.folder_id,
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
    "set_checklist_item_assignee",
    {
      description: mutationToolDescription(
        "현재 MCP caller session을 actor_kind='agent'로 하여 체크리스트 항목 담당자를 설정하거나 해제한다.",
      ),
      inputSchema: {
        folder_id: z.string().min(1),
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
        (service, actor) =>
          service.setChecklistItemAssignee({
            ...actor,
            folderId: input.folder_id,
            itemId: input.item_id,
            expectedVersion: input.expected_version,
            reason: input.reason,
            idempotencyKey: input.idempotency_key,
            ...assigneePatch(input),
          }),
      ),
  );

  registerItemArchiveTool(server, runtime, {
    name: "archive_checklist_item",
    archived: true,
    description:
      "현재 MCP caller session을 actor_kind='agent'로 하여 체크리스트 항목을 archived 처리한다.",
  });
  registerItemArchiveTool(server, runtime, {
    name: "unarchive_checklist_item",
    archived: false,
    description:
      "현재 MCP caller session을 actor_kind='agent'로 하여 archived 체크리스트 항목을 복구한다.",
  });

  server.registerTool(
    "move_checklist_item",
    {
      description: mutationToolDescription(
        "현재 MCP caller session을 actor_kind='agent'로 하여 체크리스트 항목을 다른 위치나 섹션으로 이동한다.",
      ),
      inputSchema: {
        folder_id: z.string().min(1),
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
        (service, actor) =>
          service.moveChecklistItem({
            ...actor,
            folderId: input.folder_id,
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
    "set_checklist_item_status",
    {
      description: mutationToolDescription(
        "현재 MCP caller session을 actor_kind='agent'로 하여 체크리스트 항목 상태를 설정한다.",
      ),
      inputSchema: {
        folder_id: z.string().min(1),
        item_id: z.string().min(1),
        status: checklistItemStatusSchema,
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
        (service, actor) =>
          service.setChecklistItemStatus({
            ...actor,
            folderId: input.folder_id,
            itemId: input.item_id,
            status: input.status as ChecklistItemStatus,
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
    name: "archive_checklist_item" | "unarchive_checklist_item";
    archived: boolean;
    description: string;
  },
): void {
  server.registerTool(
    config.name,
    {
      description: mutationToolDescription(config.description),
      inputSchema: {
        folder_id: z.string().min(1),
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
        (service, actor) =>
          service.updateChecklistItem({
            ...actor,
            folderId: input.folder_id,
            itemId: input.item_id,
            expectedVersion: input.expected_version,
            archived: config.archived,
            reason: input.reason,
            idempotencyKey: input.idempotency_key,
          }),
      ),
  );
}
