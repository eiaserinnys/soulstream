import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

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
} from "./runbook_shared.js";

export function registerRunbookSectionTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "create_runbook_section",
    {
      description: mutationToolDescription(
        "현재 MCP caller session을 actor_kind='agent'로 하여 런북 섹션을 생성한다.",
      ),
      inputSchema: {
        ...mutationResponseInputSchema,
        runbook_id: z.string().min(1),
        title: z.string().min(1),
        section_id: z.string().min(1).optional(),
        assignee: assigneeSchema,
        after_section_id: z.string().nullable().optional(),
        before_section_id: z.string().nullable().optional(),
        idempotency_key: idempotencyKeySchema,
        caller_session_id: callerSessionIdSchema,
      },
    },
    async (input) =>
      mutation(
        runtime,
        input.caller_session_id,
        (service, actorSessionId) =>
          service.createSection({
            actorKind: "agent",
            actorSessionId,
            runbookId: input.runbook_id,
            title: input.title,
            sectionId: input.section_id,
            afterSectionId: input.after_section_id,
            beforeSectionId: input.before_section_id,
            idempotencyKey: input.idempotency_key,
            ...assigneePatch(input),
          }),
        { targetKind: "section", includeSnapshot: input.include_snapshot },
      ),
  );

  server.registerTool(
    "update_runbook_section",
    {
      description: mutationToolDescription(
        "현재 MCP caller session을 actor_kind='agent'로 하여 런북 섹션 제목을 수정한다.",
      ),
      inputSchema: {
        ...mutationResponseInputSchema,
        runbook_id: z.string().min(1),
        section_id: z.string().min(1),
        expected_version: expectedVersionSchema,
        title: z.string().min(1),
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
          service.patchSection({
            actorKind: "agent",
            actorSessionId,
            runbookId: input.runbook_id,
            sectionId: input.section_id,
            expectedVersion: input.expected_version,
            title: input.title,
            reason: input.reason,
            idempotencyKey: input.idempotency_key,
          }),
        { targetKind: "section", includeSnapshot: input.include_snapshot },
      ),
  );

  server.registerTool(
    "set_runbook_section_assignee",
    {
      description: mutationToolDescription(
        "현재 MCP caller session을 actor_kind='agent'로 하여 런북 섹션 담당자를 설정하거나 해제한다.",
      ),
      inputSchema: {
        ...mutationResponseInputSchema,
        runbook_id: z.string().min(1),
        section_id: z.string().min(1),
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
          service.setSectionAssignee({
            actorKind: "agent",
            actorSessionId,
            runbookId: input.runbook_id,
            sectionId: input.section_id,
            expectedVersion: input.expected_version,
            reason: input.reason,
            idempotencyKey: input.idempotency_key,
            ...assigneePatch(input),
          }),
        { targetKind: "section", includeSnapshot: input.include_snapshot },
      ),
  );

  registerSectionArchiveTool(server, runtime, {
    name: "archive_runbook_section",
    archived: true,
    description:
      "현재 MCP caller session을 actor_kind='agent'로 하여 런북 섹션을 archived 처리한다.",
  });
  registerSectionArchiveTool(server, runtime, {
    name: "unarchive_runbook_section",
    archived: false,
    description:
      "현재 MCP caller session을 actor_kind='agent'로 하여 archived 런북 섹션을 복구한다.",
  });

  server.registerTool(
    "move_runbook_section",
    {
      description: mutationToolDescription(
        "현재 MCP caller session을 actor_kind='agent'로 하여 런북 섹션 position_key를 재계산한다.",
      ),
      inputSchema: {
        ...mutationResponseInputSchema,
        runbook_id: z.string().min(1),
        section_id: z.string().min(1),
        expected_version: expectedVersionSchema,
        after_section_id: z.string().nullable().optional(),
        before_section_id: z.string().nullable().optional(),
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
          service.moveSection({
            actorKind: "agent",
            actorSessionId,
            runbookId: input.runbook_id,
            sectionId: input.section_id,
            expectedVersion: input.expected_version,
            afterSectionId: input.after_section_id,
            beforeSectionId: input.before_section_id,
            reason: input.reason,
            idempotencyKey: input.idempotency_key,
          }),
        { targetKind: "section", includeSnapshot: input.include_snapshot },
      ),
  );
}

function registerSectionArchiveTool(
  server: McpServer,
  runtime: McpRuntime,
  config: {
    name: "archive_runbook_section" | "unarchive_runbook_section";
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
        runbook_id: z.string().min(1),
        section_id: z.string().min(1),
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
          service.patchSection({
            actorKind: "agent",
            actorSessionId,
            runbookId: input.runbook_id,
            sectionId: input.section_id,
            expectedVersion: input.expected_version,
            archived: config.archived,
            reason: input.reason,
            idempotencyKey: input.idempotency_key,
          }),
        { targetKind: "section", includeSnapshot: input.include_snapshot },
      ),
  );
}
