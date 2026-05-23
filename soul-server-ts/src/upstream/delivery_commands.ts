import type { Logger } from "pino";

import type { AgentRegistry } from "../agent_registry.js";
import type { TaskExecutor } from "../task/task_executor.js";
import type { TaskManager } from "../task/task_manager.js";
import type { Task } from "../task/task_models.js";
import {
  buildRespondAck,
  buildToolApprovalAck,
  type RespondAck,
  type ToolApprovalAck,
} from "./delivery_ack.js";

interface CommandLike {
  type?: string;
  requestId?: string;
  request_id?: string;
}

export interface RespondCommand extends CommandLike {
  type: "respond";
  agentSessionId?: string;
  session_id?: string;
  inputRequestId?: string;
  answers?: Record<string, unknown>;
}

export interface ToolApprovalCommand extends CommandLike {
  type: "approve_tool" | "reject_tool";
  agentSessionId?: string;
  session_id?: string;
  approvalId?: string;
  approval_id?: string;
  message?: string;
  alwaysApprove?: boolean;
  alwaysReject?: boolean;
}

interface DeliveryCommandsDeps {
  agentRegistry: Pick<AgentRegistry, "get">;
  taskManager: Pick<TaskManager, "deliverInputResponse" | "deliverToolApproval">;
  taskExecutor: Pick<TaskExecutor, "startExecution">;
  logger: Logger;
}

export class DeliveryCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryCommandError";
  }
}

/**
 * Owns upstream delivery command semantics.
 *
 * TaskDeliveryRoute owns public task delivery policy and DeliveryAck owns wire
 * ACK mapping. This boundary owns the upstream command adaptation between them:
 * command field validation, request id normalization, TaskManager delivery
 * calls, and queued approval auto-resume execution wiring.
 */
export class DeliveryCommands {
  constructor(private readonly deps: DeliveryCommandsDeps) {}

  async respond(cmd: RespondCommand): Promise<RespondAck | null> {
    const sessionId = cmd.agentSessionId ?? cmd.session_id ?? "";
    const inputRequestId = cmd.inputRequestId ?? cmd.request_id ?? "";
    if (!sessionId || !inputRequestId || !isPlainObject(cmd.answers)) {
      throw new DeliveryCommandError(
        "respond requires agentSessionId, inputRequestId, and answers",
      );
    }

    const result = await this.deps.taskManager.deliverInputResponse({
      agentSessionId: sessionId,
      requestId: inputRequestId,
      answers: cmd.answers,
    });

    const requestId = cmd.requestId ?? "";
    if (!requestId) {
      return null;
    }
    return buildRespondAck({
      requestId,
      inputRequestId,
      result,
    });
  }

  async toolApproval(cmd: ToolApprovalCommand): Promise<ToolApprovalAck | null> {
    const sessionId = cmd.agentSessionId ?? cmd.session_id ?? "";
    const approvalId = cmd.approvalId ?? cmd.approval_id ?? "";
    if (!sessionId || !approvalId) {
      throw new DeliveryCommandError(
        `${cmd.type} requires agentSessionId and approvalId`,
      );
    }

    const decision = cmd.type === "approve_tool" ? "approved" : "rejected";
    const result = await this.deps.taskManager.deliverToolApproval(
      {
        agentSessionId: sessionId,
        approvalId,
        decision,
        ...(cmd.message ? { message: cmd.message } : {}),
        ...(cmd.alwaysApprove !== undefined ? { alwaysApprove: cmd.alwaysApprove } : {}),
        ...(cmd.alwaysReject !== undefined ? { alwaysReject: cmd.alwaysReject } : {}),
      },
      (task) => this.startResumedToolApproval(task),
    );

    const requestId = cmd.requestId ?? cmd.request_id ?? "";
    if (!requestId) {
      return null;
    }
    return buildToolApprovalAck({
      requestId,
      approvalId,
      decision,
      result,
    });
  }

  private startResumedToolApproval(task: Task): void {
    if (!task.profileId) {
      this.deps.logger.error(
        { sessionId: task.agentSessionId },
        "tool approval resume aborted — task missing profileId",
      );
      return;
    }
    const agent = this.deps.agentRegistry.get(task.profileId);
    if (!agent) {
      this.deps.logger.error(
        { sessionId: task.agentSessionId, profileId: task.profileId },
        "tool approval resume aborted — agent profile not found",
      );
      return;
    }
    this.deps.taskExecutor.startExecution(task, agent);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
