import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RunbookItemStatus } from "../../db/session_db_types.js";
import type { RunbookAssigneeInput } from "../../runbook/runbook_models.js";
import type { RunbookService } from "../../runbook/runbook_service.js";
import { SOULSTREAM_AGENT_SESSION_HEADER } from "../request_context.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import { resolveEffectiveCallerSessionId } from "./caller_session.js";

const runbookItemStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

const assigneeSchema = z
  .object({
    kind: z.enum(["agent", "human", "session"]),
    agent_id: z.string().nullable().optional(),
    session_id: z.string().nullable().optional(),
    user_id: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

const idempotencyKeySchema = z.string().min(1);
const optionalReasonSchema = z.string().nullable().optional();
const expectedVersionSchema = z.number().int().positive();
type AssigneeToolInput = z.infer<typeof assigneeSchema>;

export function registerRunbookTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "create_runbook",
    {
      description:
        "현재 MCP caller session을 actor로 하여 기존 session board item에 런북을 생성한다.",
      inputSchema: {
        board_item_id: z.string().min(1),
        title: z.string().default(""),
        runbook_id: z.string().min(1).optional(),
        idempotency_key: idempotencyKeySchema,
      },
    },
    async (input) =>
      mutation(runtime, (service, actorSessionId) =>
        service.createRunbook({
          actorKind: "agent",
          actorSessionId,
          boardItemId: input.board_item_id,
          title: input.title,
          runbookId: input.runbook_id,
          idempotencyKey: input.idempotency_key,
        }),
      ),
  );

  server.registerTool(
    "create_runbook_section",
    {
      description:
        "현재 MCP caller session을 actor로 하여 런북 섹션을 생성한다.",
      inputSchema: {
        runbook_id: z.string().min(1),
        title: z.string().min(1),
        section_id: z.string().min(1).optional(),
        assignee: assigneeSchema,
        after_section_id: z.string().nullable().optional(),
        before_section_id: z.string().nullable().optional(),
        idempotency_key: idempotencyKeySchema,
      },
    },
    async (input) =>
      mutation(runtime, (service, actorSessionId) =>
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
      ),
  );

  server.registerTool(
    "update_runbook_section",
    {
      description:
        "현재 MCP caller session을 actor로 하여 런북 섹션 제목 또는 담당자를 수정한다.",
      inputSchema: {
        runbook_id: z.string().min(1),
        section_id: z.string().min(1),
        expected_version: expectedVersionSchema,
        title: z.string().min(1).optional(),
        assignee: assigneeSchema,
        reason: optionalReasonSchema,
        idempotency_key: idempotencyKeySchema,
      },
    },
    async (input) =>
      mutation(runtime, (service, actorSessionId) =>
        service.patchSection({
          actorKind: "agent",
          actorSessionId,
          runbookId: input.runbook_id,
          sectionId: input.section_id,
          expectedVersion: input.expected_version,
          title: input.title,
          reason: input.reason,
          idempotencyKey: input.idempotency_key,
          ...assigneePatch(input),
        }),
      ),
  );

  server.registerTool(
    "archive_runbook_section",
    {
      description:
        "현재 MCP caller session을 actor로 하여 런북 섹션을 archived 처리한다.",
      inputSchema: {
        runbook_id: z.string().min(1),
        section_id: z.string().min(1),
        expected_version: expectedVersionSchema,
        reason: optionalReasonSchema,
        idempotency_key: idempotencyKeySchema,
      },
    },
    async (input) =>
      mutation(runtime, (service, actorSessionId) =>
        service.patchSection({
          actorKind: "agent",
          actorSessionId,
          runbookId: input.runbook_id,
          sectionId: input.section_id,
          expectedVersion: input.expected_version,
          archived: true,
          reason: input.reason,
          idempotencyKey: input.idempotency_key,
        }),
      ),
  );

  server.registerTool(
    "move_runbook_section",
    {
      description:
        "현재 MCP caller session을 actor로 하여 런북 섹션 position_key를 재계산한다.",
      inputSchema: {
        runbook_id: z.string().min(1),
        section_id: z.string().min(1),
        expected_version: expectedVersionSchema,
        after_section_id: z.string().nullable().optional(),
        before_section_id: z.string().nullable().optional(),
        reason: optionalReasonSchema,
        idempotency_key: idempotencyKeySchema,
      },
    },
    async (input) =>
      mutation(runtime, (service, actorSessionId) =>
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
      ),
  );

  server.registerTool(
    "create_runbook_item",
    {
      description:
        "현재 MCP caller session을 actor로 하여 런북 아이템을 생성한다.",
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
      },
    },
    async (input) =>
      mutation(runtime, (service, actorSessionId) =>
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
      description:
        "현재 MCP caller session을 actor로 하여 런북 아이템 본문 또는 담당자를 수정한다.",
      inputSchema: {
        runbook_id: z.string().min(1),
        item_id: z.string().min(1),
        expected_version: expectedVersionSchema,
        title: z.string().min(1).optional(),
        how_to: z.string().optional(),
        assignee: assigneeSchema,
        reason: optionalReasonSchema,
        idempotency_key: idempotencyKeySchema,
      },
    },
    async (input) =>
      mutation(runtime, (service, actorSessionId) =>
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
          ...assigneePatch(input),
        }),
      ),
  );

  server.registerTool(
    "archive_runbook_item",
    {
      description:
        "현재 MCP caller session을 actor로 하여 런북 아이템을 archived 처리한다.",
      inputSchema: {
        runbook_id: z.string().min(1),
        item_id: z.string().min(1),
        expected_version: expectedVersionSchema,
        reason: optionalReasonSchema,
        idempotency_key: idempotencyKeySchema,
      },
    },
    async (input) =>
      mutation(runtime, (service, actorSessionId) =>
        service.patchItem({
          actorKind: "agent",
          actorSessionId,
          runbookId: input.runbook_id,
          itemId: input.item_id,
          expectedVersion: input.expected_version,
          archived: true,
          reason: input.reason,
          idempotencyKey: input.idempotency_key,
        }),
      ),
  );

  server.registerTool(
    "move_runbook_item",
    {
      description:
        "현재 MCP caller session을 actor로 하여 런북 아이템을 다른 위치나 섹션으로 이동한다.",
      inputSchema: {
        runbook_id: z.string().min(1),
        item_id: z.string().min(1),
        expected_version: expectedVersionSchema,
        section_id: z.string().nullable().optional(),
        after_item_id: z.string().nullable().optional(),
        before_item_id: z.string().nullable().optional(),
        reason: optionalReasonSchema,
        idempotency_key: idempotencyKeySchema,
      },
    },
    async (input) =>
      mutation(runtime, (service, actorSessionId) =>
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
      description:
        "현재 MCP caller session을 actor_kind='agent'로 하여 런북 아이템 상태를 설정한다.",
      inputSchema: {
        item_id: z.string().min(1),
        status: runbookItemStatusSchema,
        expected_version: expectedVersionSchema,
        reason: optionalReasonSchema,
        idempotency_key: idempotencyKeySchema,
      },
    },
    async (input) =>
      mutation(runtime, (service, actorSessionId) =>
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

async function mutation(
  runtime: McpRuntime,
  fn: (service: RunbookService, actorSessionId: string) => Promise<unknown>,
) {
  try {
    return jsonResult(await fn(getRunbookService(runtime), requireCallerSessionId()));
  } catch (err) {
    return errorResult(errorMessage(err));
  }
}

function getRunbookService(runtime: McpRuntime): RunbookService {
  if (!runtime.runbookService) {
    throw new Error("runbook service is not configured");
  }
  return runtime.runbookService;
}

function requireCallerSessionId(): string {
  const callerSessionId = resolveEffectiveCallerSessionId(undefined);
  if (!callerSessionId) {
    throw new Error(
      `caller session id is required for runbook mutation tools. Send ${SOULSTREAM_AGENT_SESSION_HEADER}.`,
    );
  }
  return callerSessionId;
}

function assigneePatch(input: { assignee?: AssigneeToolInput }):
  | { assignee?: RunbookAssigneeInput | null }
  | Record<string, never> {
  if (!Object.prototype.hasOwnProperty.call(input, "assignee")) return {};
  return { assignee: toAssignee(input.assignee ?? null) };
}

function toAssignee(input: AssigneeToolInput): RunbookAssigneeInput | null {
  if (!input) return null;
  return {
    kind: input.kind,
    agentId: input.agent_id,
    sessionId: input.session_id,
    userId: input.user_id,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
