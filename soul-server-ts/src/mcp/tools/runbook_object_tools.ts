import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { RunbookStatus } from "../../db/session_db_types.js";
import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import { SOULSTREAM_AGENT_SESSION_HEADER } from "../request_context.js";
import { resolveEffectiveCallerSessionId } from "./caller_session.js";

import {
  callerSessionIdSchema,
  errorMessage,
  expectedVersionSchema,
  getRunbookService,
  idempotencyKeySchema,
  mutation,
  mutationResponseInputSchema,
  mutationToolDescription,
  optionalReasonSchema,
  runbookStatusSchema,
} from "./runbook_shared.js";
import {
  formatRunbookMutationResponse,
  formatRunbookReadResponse,
  type RunbookMutationEnvelope,
} from "./runbook_response.js";

export function registerRunbookObjectTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  server.registerTool(
    "create_runbook",
    {
      description: mutationToolDescription(
        "현재 MCP caller session을 actor_kind='agent'로 하여 독립 runbook board item과 런북을 생성한다.",
      ),
      inputSchema: {
        ...mutationResponseInputSchema,
        folder_id: z.string().min(1),
        title: z.string().default(""),
        x: z.number().optional(),
        y: z.number().optional(),
        runbook_id: z.string().min(1).optional(),
        idempotency_key: idempotencyKeySchema,
        caller_session_id: callerSessionIdSchema,
      },
    },
    async (input) =>
      taskIdentityMutation(
        runtime,
        input.caller_session_id,
        input.include_snapshot,
        (client, actorSessionId) =>
          client.create({
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
      description: mutationToolDescription(
        "현재 MCP caller session을 actor_kind='agent'로 하여 런북 제목을 수정한다.",
      ),
      inputSchema: {
        ...mutationResponseInputSchema,
        runbook_id: z.string().min(1),
        expected_version: expectedVersionSchema,
        title: z.string().min(1),
        reason: optionalReasonSchema,
        idempotency_key: idempotencyKeySchema,
        caller_session_id: callerSessionIdSchema,
      },
    },
    async (input) =>
      taskIdentityMutation(
        runtime,
        input.caller_session_id,
        input.include_snapshot,
        (client, actorSessionId) =>
          client.update({
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
      description: mutationToolDescription(
        "현재 MCP caller session을 actor_kind='agent'로 하여 런북 자체의 open/completed 상태를 설정한다.",
      ),
      inputSchema: {
        ...mutationResponseInputSchema,
        runbook_id: z.string().min(1),
        status: runbookStatusSchema,
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
          service.setRunbookStatus({
            actorKind: "agent",
            actorSessionId,
            runbookId: input.runbook_id,
            status: input.status as RunbookStatus,
            expectedVersion: input.expected_version,
            reason: input.reason,
            idempotencyKey: input.idempotency_key,
          }),
        { targetKind: "runbook", includeSnapshot: input.include_snapshot },
      ),
  );

  server.registerTool(
    "get_runbook",
    {
      description:
        "런북을 조회한다. 기본 full snapshot을 유지하며 view=outline 또는 item_id로 응답을 축약할 수 있다.",
      inputSchema: {
        runbook_id: z.string().min(1),
        view: z.enum(["full", "outline"]).default("full"),
        item_id: z.string().min(1).optional(),
      },
    },
    async ({ runbook_id, view, item_id }) => {
      try {
        const snapshot =
          await getRunbookService(runtime).getRunbook(runbook_id);
        return jsonResult(
          formatRunbookReadResponse(snapshot, {
            view,
            itemId: item_id,
          }),
        );
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
  config: {
    name: "archive_runbook" | "unarchive_runbook";
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
        expected_version: expectedVersionSchema,
        reason: optionalReasonSchema,
        idempotency_key: idempotencyKeySchema,
        caller_session_id: callerSessionIdSchema,
      },
    },
    async (input) =>
      taskIdentityMutation(
        runtime,
        input.caller_session_id,
        input.include_snapshot,
        (client, actorSessionId) =>
          client.update({
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

async function taskIdentityMutation(
  runtime: McpRuntime,
  explicitCallerSessionId: string | null | undefined,
  includeSnapshot: boolean,
  mutateIdentity: (
    client: NonNullable<McpRuntime["runbookTaskIdentityHostClient"]>,
    actorSessionId: string,
  ) => Promise<unknown>,
) {
  try {
    const actorSessionId = resolveEffectiveCallerSessionId(
      explicitCallerSessionId,
    );
    if (!actorSessionId) {
      throw new Error(
        `caller session id is required for runbook mutation tools. Send ${SOULSTREAM_AGENT_SESSION_HEADER}.`,
      );
    }
    if (!runtime.runbookTaskIdentityHostClient) {
      throw new Error("runbook task identity host client is not configured");
    }
    const result = await mutateIdentity(
      runtime.runbookTaskIdentityHostClient,
      actorSessionId,
    );
    return jsonResult(
      formatRunbookMutationResponse(
        result as RunbookMutationEnvelope,
        "runbook",
        includeSnapshot,
      ),
    );
  } catch (err) {
    return errorResult(errorMessage(err));
  }
}
