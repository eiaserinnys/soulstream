import type { Logger } from "pino";

import {
  commandTraceFields,
  CommandDispatchError,
  type CommandHandlerMap,
  type CommandLike,
  type SendFn,
} from "./command_family.js";
import {
  ClaudeRuntimeCommandError,
  ClaudeRuntimeCommands,
  type ClaudeRuntimeBackgroundTasksCommand,
  type ClaudeRuntimeDeleteScheduleCommand,
  type ClaudeRuntimeListSchedulesCommand,
  type ClaudeRuntimeListTasksCommand,
  type ClaudeRuntimeStopTaskCommand,
  type ClaudeRuntimeTaskOutputCommand,
} from "./claude_runtime_commands.js";

interface ClaudeRuntimeCommandFamilyDeps {
  send: SendFn;
  logger: Pick<Logger, "debug" | "error">;
  claudeRuntimeCommands: ClaudeRuntimeCommands;
}

export function createClaudeRuntimeCommandFamily(
  deps: ClaudeRuntimeCommandFamilyDeps,
): CommandHandlerMap {
  return {
    claude_runtime_list_tasks: (cmd) =>
      handleClaudeRuntimeListTasks(deps, cmd as ClaudeRuntimeListTasksCommand),
    claude_runtime_task_output: (cmd) =>
      handleClaudeRuntimeTaskOutput(deps, cmd as ClaudeRuntimeTaskOutputCommand),
    claude_runtime_stop_task: (cmd) =>
      handleClaudeRuntimeStopTask(deps, cmd as ClaudeRuntimeStopTaskCommand),
    claude_runtime_background_tasks: (cmd) =>
      handleClaudeRuntimeBackgroundTasks(
        deps,
        cmd as ClaudeRuntimeBackgroundTasksCommand,
      ),
    claude_runtime_list_schedules: (cmd) =>
      handleClaudeRuntimeListSchedules(
        deps,
        cmd as ClaudeRuntimeListSchedulesCommand,
      ),
    claude_runtime_delete_schedule: (cmd) =>
      handleClaudeRuntimeDeleteSchedule(
        deps,
        cmd as ClaudeRuntimeDeleteScheduleCommand,
      ),
  };
}

async function handleClaudeRuntimeListTasks(
  deps: ClaudeRuntimeCommandFamilyDeps,
  cmd: ClaudeRuntimeListTasksCommand,
): Promise<void> {
  await sendClaudeRuntimeCommand(
    deps,
    cmd,
    () => deps.claudeRuntimeCommands.listTasks(cmd),
  );
}

async function handleClaudeRuntimeTaskOutput(
  deps: ClaudeRuntimeCommandFamilyDeps,
  cmd: ClaudeRuntimeTaskOutputCommand,
): Promise<void> {
  await sendClaudeRuntimeCommand(
    deps,
    cmd,
    () => deps.claudeRuntimeCommands.taskOutput(cmd),
  );
}

async function handleClaudeRuntimeStopTask(
  deps: ClaudeRuntimeCommandFamilyDeps,
  cmd: ClaudeRuntimeStopTaskCommand,
): Promise<void> {
  await sendClaudeRuntimeCommand(
    deps,
    cmd,
    () => deps.claudeRuntimeCommands.stopTask(cmd),
  );
}

async function handleClaudeRuntimeBackgroundTasks(
  deps: ClaudeRuntimeCommandFamilyDeps,
  cmd: ClaudeRuntimeBackgroundTasksCommand,
): Promise<void> {
  await sendClaudeRuntimeCommand(
    deps,
    cmd,
    () => deps.claudeRuntimeCommands.backgroundTasks(cmd),
  );
}

async function handleClaudeRuntimeListSchedules(
  deps: ClaudeRuntimeCommandFamilyDeps,
  cmd: ClaudeRuntimeListSchedulesCommand,
): Promise<void> {
  await sendClaudeRuntimeCommand(
    deps,
    cmd,
    () => deps.claudeRuntimeCommands.listSchedules(cmd),
  );
}

async function handleClaudeRuntimeDeleteSchedule(
  deps: ClaudeRuntimeCommandFamilyDeps,
  cmd: ClaudeRuntimeDeleteScheduleCommand,
): Promise<void> {
  await sendClaudeRuntimeCommand(
    deps,
    cmd,
    () => deps.claudeRuntimeCommands.deleteSchedule(cmd),
  );
}

async function sendClaudeRuntimeCommand(
  deps: ClaudeRuntimeCommandFamilyDeps,
  cmd: CommandLike,
  buildAck: () => Promise<Record<string, unknown>>,
): Promise<void> {
  const correlation = commandTraceFields(cmd);
  deps.logger.debug(correlation, "Claude runtime command received");
  try {
    const ack = await buildAck();
    await deps.send(ack);
    deps.logger.debug(
      {
        ...correlation,
        responseType: typeof ack.type === "string" ? ack.type : null,
      },
      "Claude runtime command response sent",
    );
  } catch (err) {
    if (err instanceof ClaudeRuntimeCommandError) {
      deps.logger.error(
        { ...correlation, error: err.message },
        "Claude runtime command rejected",
      );
      throw new CommandDispatchError(err.message);
    }
    throw err;
  }
}
