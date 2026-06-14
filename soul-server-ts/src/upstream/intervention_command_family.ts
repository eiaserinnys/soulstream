import type { ContextItem } from "../context/prompt_assembler.js";
import type { CallerInfo } from "../task/task_models.js";
import type { SupervisorDirectTargetGuard } from "../supervisor/direct_target_guard.js";
import {
  CommandDispatchError,
  type CommandHandlerMap,
  type CommandLike,
  type SendFn,
} from "./command_family.js";
import {
  DeliveryCommandError,
  DeliveryCommands,
  type RespondCommand,
  type ToolApprovalCommand,
} from "./delivery_commands.js";
import {
  TaskRuntimeCommands,
  buildInterveneAck,
} from "./task_runtime_commands.js";

interface InterveneCmd extends CommandLike {
  type: "intervene";
  agentSessionId?: string;
  session_id?: string;
  text: string;
  user?: string;
  caller_info?: CallerInfo;
  attachment_paths?: string[];
  extra_context_items?: ContextItem[];
}

interface SupervisorInterveneCmd extends CommandLike {
  type: "supervisor_intervene";
  role?: string;
  expected_epoch?: number;
  expectedEpoch?: number;
  text: string;
  user?: string;
  caller_info?: CallerInfo;
  attachment_paths?: string[];
  extra_context_items?: ContextItem[];
}

interface InterventionCommandFamilyDeps {
  send: SendFn;
  deliveryCommands: DeliveryCommands;
  taskRuntimeCommands: TaskRuntimeCommands;
  supervisorDirectTargetGuard?: SupervisorDirectTargetGuard;
}

export function createInterventionCommandFamily(
  deps: InterventionCommandFamilyDeps,
): CommandHandlerMap {
  return {
    respond: (cmd) => handleRespond(deps, cmd as RespondCommand),
    approve_tool: (cmd) => handleToolApproval(deps, cmd as ToolApprovalCommand),
    reject_tool: (cmd) => handleToolApproval(deps, cmd as ToolApprovalCommand),
    intervene: (cmd) => handleIntervene(deps, cmd as InterveneCmd),
    supervisor_intervene: (cmd) =>
      handleSupervisorIntervene(deps, cmd as SupervisorInterveneCmd),
  };
}

/**
 * `respond` 명령 — Claude AskUserQuestion/input_request 응답.
 *
 * wire에는 두 ID가 공존한다:
 * - requestId: orch command ACK 매칭용 ID
 * - inputRequestId/request_id: Claude pending input request ID
 *
 * DeliveryCommands owns validation and ACK shape. This route only sends the
 * returned ACK or maps boundary validation failures to the generic error wire.
 */
async function handleRespond(
  deps: InterventionCommandFamilyDeps,
  cmd: RespondCommand,
): Promise<void> {
  try {
    const ack = await deps.deliveryCommands.respond(cmd);
    if (ack) {
      await deps.send(ack);
    }
  } catch (err) {
    if (err instanceof DeliveryCommandError) {
      throw new CommandDispatchError(err.message);
    }
    throw err;
  }
}

/**
 * `approve_tool` / `reject_tool` 명령 — OpenAI Agents SDK RunToolApprovalItem 응답.
 *
 * Approval uses a separate command because `respond` is reserved for Claude
 * AskUserQuestion. DeliveryCommands owns delivery semantics and ACK shape.
 */
async function handleToolApproval(
  deps: InterventionCommandFamilyDeps,
  cmd: ToolApprovalCommand,
): Promise<void> {
  try {
    const ack = await deps.deliveryCommands.toolApproval(cmd);
    if (ack) {
      await deps.send(ack);
    }
  } catch (err) {
    if (err instanceof DeliveryCommandError) {
      throw new CommandDispatchError(err.message);
    }
    throw err;
  }
}

/**
 * `intervene` 명령.
 *
 * TaskRuntimeCommands owns delivery, queueing, and auto-resume. This route
 * validates the wire minimum and emits the requestId-gated `intervene_ack`.
 */
async function handleIntervene(
  deps: InterventionCommandFamilyDeps,
  cmd: InterveneCmd,
): Promise<void> {
  const sessionId = cmd.agentSessionId ?? cmd.session_id ?? "";
  if (!sessionId || !cmd.text) {
    throw new CommandDispatchError("intervene requires agentSessionId and text");
  }

  let result;
  try {
    await deps.supervisorDirectTargetGuard?.assertCanTarget(sessionId);
    result = await deps.taskRuntimeCommands.intervene({
      agentSessionId: sessionId,
      text: cmd.text,
      user: cmd.user,
      callerInfo: cmd.caller_info,
      attachmentPaths: cmd.attachment_paths,
      extraContextItems: cmd.extra_context_items,
    });
  } catch (err) {
    throw new CommandDispatchError(err instanceof Error ? err.message : String(err));
  }

  const requestId = cmd.requestId ?? cmd.request_id ?? "";
  if (!requestId) {
    // ACK 발행 안 함 (atom c13f7826 빈 string ACK 금지) — orch _send_command 미사용 경로.
    return;
  }
  await deps.send(buildInterveneAck({ requestId, agentSessionId: sessionId, result }));
}

async function handleSupervisorIntervene(
  deps: InterventionCommandFamilyDeps,
  cmd: SupervisorInterveneCmd,
): Promise<void> {
  if (!cmd.role || !cmd.text) {
    throw new CommandDispatchError("supervisor_intervene requires role and text");
  }
  if (!deps.supervisorDirectTargetGuard) {
    throw new CommandDispatchError("supervisor_intervene requires SessionDB");
  }

  let sessionId;
  try {
    sessionId = await deps.supervisorDirectTargetGuard.resolveActiveSession({
      role: cmd.role,
      expectedEpoch: cmd.expectedEpoch ?? cmd.expected_epoch,
    });
  } catch (err) {
    throw new CommandDispatchError(err instanceof Error ? err.message : String(err));
  }

  let result;
  try {
    result = await deps.taskRuntimeCommands.intervene({
      agentSessionId: sessionId,
      text: cmd.text,
      user: cmd.user ?? "supervisor",
      callerInfo: cmd.caller_info,
      attachmentPaths: cmd.attachment_paths,
      extraContextItems: cmd.extra_context_items,
    });
  } catch (err) {
    throw new CommandDispatchError(err instanceof Error ? err.message : String(err));
  }

  const requestId = cmd.requestId ?? cmd.request_id ?? "";
  if (!requestId) return;
  await deps.send(buildInterveneAck({ requestId, agentSessionId: sessionId, result }));
}
