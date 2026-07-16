import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { errorResult, jsonResult } from "../result.js";
import type { McpRuntime } from "../runtime.js";
import {
  TASK_CREATION_DEPRECATED_MESSAGE,
  TaskTreeService,
} from "../../task_tree/task_tree_service.js";
import { TASK_STATUSES } from "../../task_tree/task_tree_repository.js";

const taskStatusSchema = z.enum(TASK_STATUSES);
const verificationOwnerSchema = z.enum(["agent", "user", "both"]);
const delegatedContainerSchema = z.object({
  kind: z.enum(["folder", "runbook"]),
  id: z.string().min(1),
});

export function registerTaskTreeTools(
  server: McpServer,
  runtime: McpRuntime,
): void {
  let service: TaskTreeService | null = null;
  const getService = () => {
    service ??= new TaskTreeService(runtime);
    return service;
  };

  server.registerTool(
    "create_task_item",
    {
      description:
        `DEPRECATED: ${TASK_CREATION_DEPRECATED_MESSAGE}`,
      inputSchema: {
        session_id: z.string(),
        title: z.string().min(1),
        description: z.string().optional(),
        acceptance_criteria: z.string().optional(),
        verification_owner: verificationOwnerSchema.default("agent"),
        parent_task_id: z.string().nullable().optional(),
        status: taskStatusSchema.default("open"),
        set_active: z.boolean().default(false),
        idempotency_key: z.string().nullable().optional(),
        linked_session_id: z.string().nullable().optional(),
        linked_node_id: z.string().nullable().optional(),
        navigation_session_id: z.string().nullable().optional(),
        navigation_node_id: z.string().nullable().optional(),
        navigation_event_id: z.number().int().positive().nullable().optional(),
      },
    },
    async (input) => {
      try {
        return jsonResult(
          await getService().createTaskItem({
            sessionId: input.session_id,
            title: input.title,
            description: input.description,
            acceptanceCriteria: input.acceptance_criteria,
            verificationOwner: input.verification_owner,
            parentTaskId: input.parent_task_id,
            status: input.status,
            setActive: input.set_active,
            idempotencyKey: input.idempotency_key,
            linkedSessionId: input.linked_session_id,
            linkedNodeId: input.linked_node_id,
            navigationSessionId: input.navigation_session_id,
            navigationNodeId: input.navigation_node_id,
            navigationEventId: input.navigation_event_id,
          }),
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "delegate_task_item",
    {
      description:
        `DEPRECATED: ${TASK_CREATION_DEPRECATED_MESSAGE}`,
      inputSchema: {
        session_id: z.string(),
        parent_task_id: z.string(),
        title: z.string().min(1),
        prompt: z.string().min(1),
        agent_id: z.string().optional(),
        notify_completion: z.boolean().optional(),
        description: z.string().optional(),
        acceptance_criteria: z.string().optional(),
        verification_owner: verificationOwnerSchema.default("agent"),
        idempotency_key: z.string().nullable().optional(),
        folder_id: z.string().nullable().optional(),
        container: delegatedContainerSchema.optional(),
        source_runbook_item_id: z.string().nullable().optional(),
      },
    },
    async (input) => {
      try {
        return jsonResult(
          await getService().delegateTaskItem({
            sessionId: input.session_id,
            parentTaskId: input.parent_task_id,
            title: input.title,
            prompt: input.prompt,
            agentId: input.agent_id,
            notifyCompletion: input.notify_completion,
            description: input.description,
            acceptanceCriteria: input.acceptance_criteria,
            verificationOwner: input.verification_owner,
            idempotencyKey: input.idempotency_key,
            folderId: input.folder_id,
            container: input.container ?? null,
            sourceRunbookItemId: input.source_runbook_item_id,
          }),
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

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
        "Task Tree item을 검색하거나 root/linked session 기준으로 path와 함께 조회한다.",
      inputSchema: {
        query: z.string().optional(),
        status: taskStatusSchema.optional(),
        root_task_id: z.string().optional(),
        linked_session_id: z.string().optional(),
        include_archived: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    async (input) => {
      try {
        return jsonResult(
          await getService().searchTaskItems({
            query: input.query,
            status: input.status,
            rootTaskId: input.root_task_id,
            linkedSessionId: input.linked_session_id,
            includeArchived: input.include_archived,
            limit: input.limit,
          }),
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "move_task_item",
    {
      description:
        "Task Tree item을 다른 parent 아래로 이동한다. 자기 자신 또는 descendant 아래 이동은 거부한다.",
      inputSchema: {
        session_id: z.string(),
        task_id: z.string(),
        new_parent_task_id: z.string().nullable().optional(),
        position_key: z.number().optional(),
        reason: z.string().nullable().optional(),
        expected_version: z.number().int().positive().nullable().optional(),
        idempotency_key: z.string().nullable().optional(),
      },
    },
    async (input) => {
      try {
        return jsonResult(
          await getService().moveTaskItem({
            sessionId: input.session_id,
            taskId: input.task_id,
            newParentTaskId: input.new_parent_task_id,
            positionKey: input.position_key,
            reason: input.reason,
            expectedVersion: input.expected_version,
            idempotencyKey: input.idempotency_key,
          }),
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "update_task_item",
    {
      description:
        "Task item의 title/description/acceptance criteria/verification owner를 수정하고 operation event anchor를 남긴다.",
      inputSchema: {
        session_id: z.string(),
        task_id: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        acceptance_criteria: z.string().optional(),
        verification_owner: verificationOwnerSchema.optional(),
        reason: z.string().nullable().optional(),
        expected_version: z.number().int().positive().nullable().optional(),
      },
    },
    async (input) => {
      try {
        return jsonResult(
          await getService().updateTaskItem({
            sessionId: input.session_id,
            taskId: input.task_id,
            title: input.title,
            description: input.description,
            acceptanceCriteria: input.acceptance_criteria,
            verificationOwner: input.verification_owner,
            reason: input.reason,
            expectedVersion: input.expected_version,
          }),
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "set_task_status",
    {
      description:
        "Task status를 open/in_progress/agent_done/verified_done/reopened/blocked/cancelled 중 하나로 설정한다.",
      inputSchema: {
        session_id: z.string(),
        task_id: z.string(),
        status: taskStatusSchema,
        reason: z.string().nullable().optional(),
        expected_version: z.number().int().positive().nullable().optional(),
        idempotency_key: z.string().nullable().optional(),
      },
    },
    async (input) => {
      try {
        return jsonResult(
          await getService().setStatus({
            sessionId: input.session_id,
            taskId: input.task_id,
            status: input.status,
            reason: input.reason,
            expectedVersion: input.expected_version,
            idempotencyKey: input.idempotency_key,
          }),
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "link_task_session",
    {
      description:
        "Task item을 session/node/event anchor에 연결한다. navigation_event_id 생략 시 linked session top(NULL event)으로 이동한다. operation event로 이동해야 할 때만 use_operation_anchor=true를 사용한다.",
      inputSchema: {
        session_id: z.string(),
        task_id: z.string(),
        linked_session_id: z.string(),
        linked_node_id: z.string().nullable().optional(),
        navigation_event_id: z.number().int().positive().nullable().optional(),
        use_operation_anchor: z.boolean().default(false),
        reason: z.string().nullable().optional(),
        expected_version: z.number().int().positive().nullable().optional(),
      },
    },
    async (input) => {
      try {
        return jsonResult(
          await getService().linkSession({
            sessionId: input.session_id,
            taskId: input.task_id,
            linkedSessionId: input.linked_session_id,
            linkedNodeId: input.linked_node_id,
            navigationEventId: input.navigation_event_id,
            useOperationAnchor: input.use_operation_anchor,
            reason: input.reason,
            expectedVersion: input.expected_version,
          }),
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "set_active_task",
    {
      description:
        "세션의 active task context를 설정하거나 null로 해제한다. get_task_context로 resume 후 복구할 수 있다.",
      inputSchema: {
        session_id: z.string(),
        task_id: z.string().nullable().optional(),
        reason: z.string().nullable().optional(),
      },
    },
    async (input) => {
      try {
        return jsonResult(
          await getService().setActiveTask({
            sessionId: input.session_id,
            taskId: input.task_id,
            reason: input.reason,
          }),
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "archive_task_item",
    {
      description:
        "Task item을 archive 처리한다. 삭제하지 않고 현재 조회에서 숨기며 operation event anchor를 남긴다.",
      inputSchema: {
        session_id: z.string(),
        task_id: z.string(),
        reason: z.string().nullable().optional(),
        expected_version: z.number().int().positive().nullable().optional(),
      },
    },
    async (input) => {
      try {
        return jsonResult(
          await getService().archiveTaskItem({
            sessionId: input.session_id,
            taskId: input.task_id,
            reason: input.reason,
            expectedVersion: input.expected_version,
          }),
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "set_task_pinned",
    {
      description:
        "Task item의 pinned canonical state를 설정한다. pinned task는 같은 sibling 그룹 안에서 최상단에 정렬된다.",
      inputSchema: {
        session_id: z.string(),
        task_id: z.string(),
        pinned: z.boolean(),
        reason: z.string().nullable().optional(),
        expected_version: z.number().int().positive().nullable().optional(),
        idempotency_key: z.string().nullable().optional(),
      },
    },
    async (input) => {
      try {
        return jsonResult(
          await getService().setPinned({
            sessionId: input.session_id,
            taskId: input.task_id,
            pinned: input.pinned,
            reason: input.reason,
            expectedVersion: input.expected_version,
            idempotencyKey: input.idempotency_key,
          }),
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "pin_task_item",
    {
      description:
        "Task item을 같은 sibling 그룹 최상단에 고정한다. set_task_pinned(pinned=true)의 명시 alias.",
      inputSchema: {
        session_id: z.string(),
        task_id: z.string(),
        reason: z.string().nullable().optional(),
        expected_version: z.number().int().positive().nullable().optional(),
        idempotency_key: z.string().nullable().optional(),
      },
    },
    async (input) => {
      try {
        return jsonResult(
          await getService().setPinned({
            sessionId: input.session_id,
            taskId: input.task_id,
            pinned: true,
            reason: input.reason,
            expectedVersion: input.expected_version,
            idempotencyKey: input.idempotency_key,
          }),
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "unpin_task_item",
    {
      description:
        "Task item의 고정을 해제한다. set_task_pinned(pinned=false)의 명시 alias.",
      inputSchema: {
        session_id: z.string(),
        task_id: z.string(),
        reason: z.string().nullable().optional(),
        expected_version: z.number().int().positive().nullable().optional(),
        idempotency_key: z.string().nullable().optional(),
      },
    },
    async (input) => {
      try {
        return jsonResult(
          await getService().setPinned({
            sessionId: input.session_id,
            taskId: input.task_id,
            pinned: false,
            reason: input.reason,
            expectedVersion: input.expected_version,
            idempotencyKey: input.idempotency_key,
          }),
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "hold_task_item",
    {
      description:
        "Task item을 보류 상태로 둔다. 별도 paused status를 만들지 않고 기존 blocked status로 매핑하되 operation_type=hold_task_item으로 의도를 남긴다.",
      inputSchema: {
        session_id: z.string(),
        task_id: z.string(),
        reason: z.string().nullable().optional(),
        expected_version: z.number().int().positive().nullable().optional(),
        idempotency_key: z.string().nullable().optional(),
      },
    },
    async (input) => {
      try {
        return jsonResult(
          await getService().holdTaskItem({
            sessionId: input.session_id,
            taskId: input.task_id,
            reason: input.reason,
            expectedVersion: input.expected_version,
            idempotencyKey: input.idempotency_key,
          }),
        );
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "list_task_delegate_agents",
    {
      description:
        "DEPRECATED: delegate_task_item 신규 생성이 중단되어 위임 준비에 사용하지 않는다. 기존 v1 Task Tree 호환 조회만 유지한다.",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult({
          agents: runtime.agentRegistry.list().map((agent) => ({
            id: agent.id,
            name: agent.name,
            backend: "backend" in agent ? agent.backend : undefined,
          })),
        });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "list_task_operations",
    {
      description:
        "Task item의 append-only operation 이력을 최신순으로 조회한다.",
      inputSchema: {
        task_id: z.string(),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    async ({ task_id, limit }) => {
      try {
        return jsonResult(await getService().listOperations(task_id, limit));
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
