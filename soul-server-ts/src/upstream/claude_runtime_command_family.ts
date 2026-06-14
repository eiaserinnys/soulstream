import {
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
    () => deps.claudeRuntimeCommands.listTasks(cmd),
  );
}

async function handleClaudeRuntimeTaskOutput(
  deps: ClaudeRuntimeCommandFamilyDeps,
  cmd: ClaudeRuntimeTaskOutputCommand,
): Promise<void> {
  await sendClaudeRuntimeCommand(
    deps,
    () => deps.claudeRuntimeCommands.taskOutput(cmd),
  );
}

async function handleClaudeRuntimeStopTask(
  deps: ClaudeRuntimeCommandFamilyDeps,
  cmd: ClaudeRuntimeStopTaskCommand,
): Promise<void> {
  await sendClaudeRuntimeCommand(
    deps,
    () => deps.claudeRuntimeCommands.stopTask(cmd),
  );
}

async function handleClaudeRuntimeBackgroundTasks(
  deps: ClaudeRuntimeCommandFamilyDeps,
  cmd: ClaudeRuntimeBackgroundTasksCommand,
): Promise<void> {
  await sendClaudeRuntimeCommand(
    deps,
    () => deps.claudeRuntimeCommands.backgroundTasks(cmd),
  );
}

async function handleClaudeRuntimeListSchedules(
  deps: ClaudeRuntimeCommandFamilyDeps,
  cmd: ClaudeRuntimeListSchedulesCommand,
): Promise<void> {
  await sendClaudeRuntimeCommand(
    deps,
    () => deps.claudeRuntimeCommands.listSchedules(cmd),
  );
}

async function handleClaudeRuntimeDeleteSchedule(
  deps: ClaudeRuntimeCommandFamilyDeps,
  cmd: ClaudeRuntimeDeleteScheduleCommand,
): Promise<void> {
  await sendClaudeRuntimeCommand(
    deps,
    () => deps.claudeRuntimeCommands.deleteSchedule(cmd),
  );
}

async function sendClaudeRuntimeCommand(
  deps: ClaudeRuntimeCommandFamilyDeps,
  buildAck: () => Promise<Record<string, unknown> | null>,
): Promise<void> {
  try {
    const ack = await buildAck();
    if (ack) await deps.send(ack);
  } catch (err) {
    if (err instanceof ClaudeRuntimeCommandError) {
      throw new CommandDispatchError(err.message);
    }
    throw err;
  }
}
