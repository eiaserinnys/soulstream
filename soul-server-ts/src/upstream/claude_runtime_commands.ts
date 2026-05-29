import type { TaskManager } from "../task/task_manager.js";
import type {
  ScheduleDeleteResponse,
  ScheduleListResponse,
} from "../schedule/schedule_models.js";

interface CommandLike {
  type?: string;
  requestId?: string;
  request_id?: string;
}

export interface ClaudeRuntimeListTasksCommand extends CommandLike {
  type: "claude_runtime_list_tasks";
  agentSessionId?: string;
  session_id?: string;
}

export interface ClaudeRuntimeTaskOutputCommand extends CommandLike {
  type: "claude_runtime_task_output";
  agentSessionId?: string;
  session_id?: string;
  taskId?: string;
  task_id?: string;
}

export interface ClaudeRuntimeStopTaskCommand extends CommandLike {
  type: "claude_runtime_stop_task";
  agentSessionId?: string;
  session_id?: string;
  taskId?: string;
  task_id?: string;
}

export interface ClaudeRuntimeBackgroundTasksCommand extends CommandLike {
  type: "claude_runtime_background_tasks";
  agentSessionId?: string;
  session_id?: string;
  toolUseId?: string;
  tool_use_id?: string;
}

export interface ClaudeRuntimeListSchedulesCommand extends CommandLike {
  type: "claude_runtime_list_schedules";
  agentSessionId?: string;
  session_id?: string;
}

export interface ClaudeRuntimeDeleteScheduleCommand extends CommandLike {
  type: "claude_runtime_delete_schedule";
  agentSessionId?: string;
  session_id?: string;
  scheduleId?: string;
  schedule_id?: string;
}

type ClaudeRuntimeCommand =
  | ClaudeRuntimeListTasksCommand
  | ClaudeRuntimeTaskOutputCommand
  | ClaudeRuntimeStopTaskCommand
  | ClaudeRuntimeBackgroundTasksCommand
  | ClaudeRuntimeListSchedulesCommand
  | ClaudeRuntimeDeleteScheduleCommand;

export interface ClaudeRuntimeScheduleCommands {
  listSchedules(sessionId: string): Promise<ScheduleListResponse>;
  deleteSchedule(sessionId: string, scheduleId: string): Promise<ScheduleDeleteResponse>;
}

export class ClaudeRuntimeCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeRuntimeCommandError";
  }
}

export class ClaudeRuntimeCommands {
  constructor(
    private readonly taskManager: Pick<
      TaskManager,
      | "listClaudeRuntimeTasks"
      | "getClaudeRuntimeTaskOutput"
      | "stopClaudeRuntimeTask"
      | "backgroundClaudeRuntimeTasks"
    >,
    private readonly schedules?: ClaudeRuntimeScheduleCommands,
  ) {}

  async listTasks(cmd: ClaudeRuntimeListTasksCommand): Promise<Record<string, unknown> | null> {
    const sessionId = sessionIdFromCommand(cmd);
    if (!sessionId) throw new ClaudeRuntimeCommandError(`${cmd.type} requires agentSessionId`);
    const result = await this.taskManager.listClaudeRuntimeTasks(sessionId);
    return this.ack(cmd, result);
  }

  async listSchedules(
    cmd: ClaudeRuntimeListSchedulesCommand,
  ): Promise<Record<string, unknown> | null> {
    if (!this.schedules) {
      throw new ClaudeRuntimeCommandError("schedule service is not configured");
    }
    const sessionId = sessionIdFromCommand(cmd);
    if (!sessionId) throw new ClaudeRuntimeCommandError(`${cmd.type} requires agentSessionId`);
    const result = await this.schedules.listSchedules(sessionId);
    return this.ack(cmd, result);
  }

  async deleteSchedule(
    cmd: ClaudeRuntimeDeleteScheduleCommand,
  ): Promise<Record<string, unknown> | null> {
    if (!this.schedules) {
      throw new ClaudeRuntimeCommandError("schedule service is not configured");
    }
    const sessionId = sessionIdFromCommand(cmd);
    const scheduleId = cmd.scheduleId ?? cmd.schedule_id ?? "";
    if (!sessionId || !scheduleId) {
      throw new ClaudeRuntimeCommandError(
        `${cmd.type} requires agentSessionId and scheduleId`,
      );
    }
    const result = await this.schedules.deleteSchedule(sessionId, scheduleId);
    return this.ack(cmd, result);
  }

  async taskOutput(
    cmd: ClaudeRuntimeTaskOutputCommand,
  ): Promise<Record<string, unknown> | null> {
    const sessionId = sessionIdFromCommand(cmd);
    const taskId = cmd.taskId ?? cmd.task_id ?? "";
    if (!sessionId || !taskId) {
      throw new ClaudeRuntimeCommandError(
        `${cmd.type} requires agentSessionId and taskId`,
      );
    }
    const result = await this.taskManager.getClaudeRuntimeTaskOutput(sessionId, taskId);
    return this.ack(cmd, result);
  }

  async stopTask(cmd: ClaudeRuntimeStopTaskCommand): Promise<Record<string, unknown> | null> {
    const sessionId = sessionIdFromCommand(cmd);
    const taskId = cmd.taskId ?? cmd.task_id ?? "";
    if (!sessionId || !taskId) {
      throw new ClaudeRuntimeCommandError(
        `${cmd.type} requires agentSessionId and taskId`,
      );
    }
    const result = await this.taskManager.stopClaudeRuntimeTask(sessionId, taskId);
    return this.ack(cmd, result);
  }

  async backgroundTasks(
    cmd: ClaudeRuntimeBackgroundTasksCommand,
  ): Promise<Record<string, unknown> | null> {
    const sessionId = sessionIdFromCommand(cmd);
    if (!sessionId) throw new ClaudeRuntimeCommandError(`${cmd.type} requires agentSessionId`);
    const result = await this.taskManager.backgroundClaudeRuntimeTasks(
      sessionId,
      cmd.toolUseId ?? cmd.tool_use_id,
    );
    return this.ack(cmd, result);
  }

  private ack(cmd: ClaudeRuntimeCommand, result: object): Record<string, unknown> | null {
    const requestId = cmd.requestId ?? cmd.request_id ?? "";
    if (!requestId) return null;
    return {
      type: `${cmd.type}_ack`,
      requestId,
      status: "ok",
      ...result,
    };
  }
}

function sessionIdFromCommand(cmd: ClaudeRuntimeCommand): string {
  return cmd.agentSessionId ?? cmd.session_id ?? "";
}
