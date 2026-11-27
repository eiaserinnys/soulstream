import type { AttachmentPathBinding } from "@soulstream/wire-schema/attachments";
import type { ContextItem } from "@soulstream/wire-schema";
import type { CallerInfo } from "../task/task_models.js";
import type { DeliveryMetadataWireFields } from "@soulstream/wire-schema/session-delivery";
import { nodeResponseRejection } from "../task/state/node_response_handling.js";
import { RESUME_REJECTED_CODE, ResumeRejectedError } from "../task/resume_rejected_error.js";
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
  type OrchestrationWorkerAdmission,
} from "./task_runtime_commands.js";
import { hasPromptInput } from "./session_command_family.js";

interface InterveneCmd extends CommandLike, DeliveryMetadataWireFields {
  type: "intervene";
  orchestrationAdmission?: OrchestrationWorkerAdmission;
  agentSessionId?: string;
  text: string;
  user?: string;
  caller_info?: CallerInfo;
  attachment_paths?: string[];
  attachment_ids?: string[];
  attachment_bindings?: AttachmentPathBinding[];
  extra_context_items?: ContextItem[];
  _conversation_text?: string;
}

interface InterventionCommandFamilyDeps {
  send: SendFn;
  deliveryCommands: DeliveryCommands;
  taskRuntimeCommands: TaskRuntimeCommands;
}

export function createInterventionCommandFamily(
  deps: InterventionCommandFamilyDeps,
): CommandHandlerMap {
  return {
    respond: (cmd) => handleRespond(deps, cmd as RespondCommand),
    approve_tool: (cmd) => handleToolApproval(deps, cmd as ToolApprovalCommand),
    reject_tool: (cmd) => handleToolApproval(deps, cmd as ToolApprovalCommand),
    ensure_session_running: async (command) => {
      const cmd=command as unknown as InterveneCmd;
      if (!cmd.agentSessionId || !hasPromptInput(cmd.text, cmd.attachment_ids, cmd.attachment_paths) || !cmd.delivery_id) throw new CommandDispatchError("ensure_session_running requires session, text and delivery_id");
      const result=await deps.taskRuntimeCommands.ensureSessionRunning({agentSessionId:cmd.agentSessionId,text:cmd.text,deliveryId:cmd.delivery_id,callerInfo:cmd.caller_info,attachmentPaths:cmd.attachment_paths,attachmentIds:cmd.attachment_ids,attachmentBindings:cmd.attachment_bindings});
      const requestId=cmd.requestId ?? cmd.request_id;
      if(requestId) await deps.send({type:"ensure_session_running_ack",requestId,agentSessionId:cmd.agentSessionId,status:"ok",...result});
    },
    intervene: (cmd) => handleIntervene(deps, cmd as InterveneCmd),
  };
}

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
  const sessionId = cmd.agentSessionId ?? "";
  if (!sessionId || !hasPromptInput(cmd.text, cmd.attachment_ids, cmd.attachment_paths)) {
    throw new CommandDispatchError("intervene requires agentSessionId and text");
  }

  let result;
  try {
    result = await deps.taskRuntimeCommands.intervene({
      agentSessionId: sessionId,
      orchestrationAdmission: cmd.orchestrationAdmission,
      text: cmd.text,
      user: cmd.user,
      callerInfo: cmd.caller_info,
      attachmentPaths: cmd.attachment_paths,
      attachmentIds: cmd.attachment_ids,
      attachmentBindings: cmd.attachment_bindings,
      extraContextItems: cmd.extra_context_items,
      conversationText: cmd._conversation_text,
      deliveryId: cmd.delivery_id,
      deliveryIntent: cmd.delivery_intent,
      source: cmd.source,
      completionId: cmd.completion_id,
      relationKey: cmd.relation_key,
      producerTerminalRevision: cmd.producer_terminal_revision,
      parentDeliveryId: cmd.parent_delivery_id,
      callerTurnId: cmd.caller_turn_id,
      deliveryCreatedAt: cmd.created_at,
      deliveryAttemptToken: cmd.delivery_attempt_token,
      rateLimitType: cmd.rate_limit_type,
      resetsAt: cmd.resets_at,
    });
  } catch (err) {
    const verdict = nodeResponseRejection(err);
    if (verdict) {
      throw new CommandDispatchError((err as Error).message, "NODE_RESPONSE_REJECTED", {
        reason: verdict.facts.reason ?? null,
        cell: verdict.decision.cell,
        intents: verdict.decision.intents,
      });
    }
    if (err instanceof ResumeRejectedError) {
      throw new CommandDispatchError(err.message, RESUME_REJECTED_CODE);
    }
    throw new CommandDispatchError(err instanceof Error ? err.message : String(err));
  }

  const requestId = cmd.requestId ?? cmd.request_id ?? "";
  if (!requestId) {
    // ACK 발행 안 함 (atom c13f7826 빈 string ACK 금지) — orch _send_command 미사용 경로.
    return;
  }
  await deps.send(buildInterveneAck({ requestId, agentSessionId: sessionId, result }));
}
