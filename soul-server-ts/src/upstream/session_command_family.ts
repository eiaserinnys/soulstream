import type { Logger } from "pino";

import type { ContextItem } from "../context/prompt_assembler.js";
import type { BoardYjsContainerRef } from "../db/session_db.js";
import type { ClaudePermissionMode, ReasoningEffort } from "../engine/protocol.js";
import type { TaskManager } from "../task/task_manager.js";
import type { CallerInfo, Task } from "../task/task_models.js";
import {
  CommandDispatchError,
  commandRequestId,
  type CommandHandlerMap,
  type CommandLike,
  type SendFn,
} from "./command_family.js";
import {
  SessionListCommandError,
  SessionListCommands,
} from "./session_list_commands.js";
import {
  TaskRuntimeCommands,
  UnknownAgentProfileError,
  buildSessionCreatedAck,
} from "./task_runtime_commands.js";

interface CreateSessionCmd extends CommandLike {
  type: "create_session";
  agentSessionId: string;
  prompt: string;
  profile?: string;
  caller_session_id?: string | null;
  caller_info?: CallerInfo;
  attachment_paths?: string[];
  extra_context_items?: ContextItem[];
  model?: string | null;
  oauth_token?: string | null;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  use_mcp?: boolean;
  claude_permission_mode?: ClaudePermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  useMcp?: boolean;
  claudePermissionMode?: ClaudePermissionMode;
  reasoningEffort?: ReasoningEffort;
  folderId?: string | null;
  container?: { kind: BoardYjsContainerRef["containerKind"]; id: string } | null;
  sourceRunbookItemId?: string | null;
  /**
   * Python parity: upstream `systemPrompt` forwards into the session's
   * system_prompt without renaming on the wire.
   */
  systemPrompt?: string;
}

interface InterruptSessionCmd extends CommandLike {
  type: "interrupt_session";
  agentSessionId?: string;
  session_id?: string;
}

interface SubscribeEventsCmd extends CommandLike {
  type: "subscribe_events";
  agentSessionId?: string;
  session_id?: string;
  subscribeId?: string;
}

type ListSessionsCmd = CommandLike & { type: "list_sessions" };

interface SessionCommandFamilyDeps {
  send: SendFn;
  logger: Logger;
  taskManager: Pick<TaskManager, "cancelTask">;
  taskRuntimeCommands: TaskRuntimeCommands;
  sessionListCommands: SessionListCommands;
}

export function createSessionCommandFamily(
  deps: SessionCommandFamilyDeps,
): CommandHandlerMap {
  return {
    create_session: (cmd) => handleCreateSession(deps, cmd as CreateSessionCmd),
    interrupt_session: (cmd) =>
      handleInterruptSession(deps, cmd as InterruptSessionCmd),
    subscribe_events: (cmd) =>
      handleSubscribeEvents(deps, cmd as SubscribeEventsCmd),
    list_sessions: (cmd) => handleListSessions(deps, cmd as ListSessionsCmd),
  };
}

/**
 * `create_session` 명령.
 *
 * TaskRuntimeCommands owns profile lookup, task creation, attachment context,
 * backend-specific OAuth forwarding, and startExecution. This route keeps the
 * minimal wire guard and requestId-gated `session_created` ACK.
 */
async function handleCreateSession(
  deps: SessionCommandFamilyDeps,
  cmd: CreateSessionCmd,
): Promise<void> {
  if (!cmd.agentSessionId || !cmd.prompt) {
    throw new CommandDispatchError("create_session requires agentSessionId and prompt");
  }
  const profileId = cmd.profile;
  if (!profileId) {
    throw new CommandDispatchError("create_session requires profile (agent id)");
  }
  let task: Task;
  try {
    task = await deps.taskRuntimeCommands.createSession({
      agentSessionId: cmd.agentSessionId,
      prompt: cmd.prompt,
      profileId,
      callerSessionId: cmd.caller_session_id ?? null,
      callerInfo: cmd.caller_info,
      model: cmd.model,
      oauthToken: cmd.oauth_token,
      reasoningEffort: cmd.reasoningEffort,
      allowedTools: cmd.allowed_tools ?? cmd.allowedTools,
      disallowedTools: cmd.disallowed_tools ?? cmd.disallowedTools,
      useMcp: cmd.use_mcp ?? cmd.useMcp,
      claudePermissionMode: cmd.claude_permission_mode ?? cmd.claudePermissionMode,
      folderId: cmd.folderId ?? null,
      container: cmd.container
        ? { containerKind: cmd.container.kind, containerId: cmd.container.id }
        : null,
      sourceRunbookItemId: cmd.sourceRunbookItemId ?? null,
      systemPrompt: cmd.systemPrompt,
      extraContextItems: cmd.extra_context_items,
      attachmentPaths: cmd.attachment_paths,
    });
  } catch (err) {
    if (err instanceof UnknownAgentProfileError) {
      throw new CommandDispatchError(err.message);
    }
    throw err;
  }

  // session_created wire는 *두 경로*가 같은 type을 사용 — orch는 payload 키로 구분:
  //   1. dispatcher ACK (여기): {type, agentSessionId, requestId}  — *requestId 있을 때만*
  //   2. SessionBroadcaster.emitSessionCreated: {type, session, folder_id, caller_source}
  // Python `command_handler.py` L222-227 / `session_broadcaster.py` L67-77 정본 패턴.
  // requestId 없으면 ACK 발행 안 함 (atom c13f7826 빈 string ACK 금지).
  const requestId = cmd.requestId ?? cmd.request_id ?? "";
  if (requestId) {
    await deps.send(
      buildSessionCreatedAck({
        requestId,
        agentSessionId: task.agentSessionId,
      }),
    );
  }
}

async function handleInterruptSession(
  deps: SessionCommandFamilyDeps,
  cmd: InterruptSessionCmd,
): Promise<void> {
  const sessionId = cmd.agentSessionId ?? cmd.session_id ?? "";
  if (!sessionId) {
    throw new CommandDispatchError("interrupt_session requires agentSessionId");
  }

  const interrupted = await deps.taskManager.cancelTask(sessionId);
  const requestId = cmd.requestId ?? cmd.request_id ?? "";
  if (!requestId) return;
  await deps.send({
    type: "interrupt_session_ack",
    requestId,
    status: "ok",
    interrupted,
    agentSessionId: sessionId,
  });
}

/**
 * `subscribe_events` 명령.
 *
 * TS task execution already emits each task event through
 * broadcaster.emitEventEnvelope, so there is no separate relay loop to start.
 * The orch caller sends this command fire-and-forget, and Python also emits no
 * ACK for this command.
 */
async function handleSubscribeEvents(
  deps: SessionCommandFamilyDeps,
  cmd: SubscribeEventsCmd,
): Promise<void> {
  const sessionId = cmd.agentSessionId ?? cmd.session_id ?? "";
  deps.logger.info(
    { sessionId, subscribeId: cmd.subscribeId },
    "subscribe_events received — NOOP 수락 (broadcaster가 EVT_EVENT 직접 emit)",
  );
  // NOOP — ACK 없이 silent 수락.
}

/**
 * `list_sessions` 명령 — Python `_handle_list_sessions` 정합.
 *
 * 응답 wire: `{type:"sessions_update", sessions, total, requestId}`.
 *
 * 응답 dict richness 한계: Python은 `get_all_sessions`로 `_build_session_dict` enrich된 dict를
 * 반환하지만 TS는 현재 `listSessionsSummary` (경량 summary)만 노출. wire 소비자(orch
 * `_on_sessions_update`)는 dict를 그대로 저장하므로 키 일관성만 유지하면 동작.
 *
 * SessionListCommands가 hard limit, default offset, sessionDb 의존성 검증, payload 조립을 소유한다.
 */
async function handleListSessions(
  deps: SessionCommandFamilyDeps,
  cmd: ListSessionsCmd,
): Promise<void> {
  try {
    await deps.send(
      await deps.sessionListCommands.listSessions({
        requestId: commandRequestId(cmd),
      }),
    );
  } catch (err) {
    if (err instanceof SessionListCommandError) {
      throw new CommandDispatchError(err.message);
    }
    throw err;
  }
}
