import type { EnginePort } from "../engine/protocol.js";

import {
  InProcessRunnerCommandDispatcher,
  type RunnerCommandDispatcher,
} from "./runner_command_dispatcher.js";

/**
 * One live Task runner. Engine capabilities and lifecycle commands are
 * configured atomically so a Task cannot retain an engine without its command
 * dispatcher.
 */
export interface TaskRunnerRuntime {
  readonly engine: EnginePort;
  readonly dispatcher: RunnerCommandDispatcher;
}

export function createTaskRunnerRuntime(
  engine: EnginePort,
  dispatcher: RunnerCommandDispatcher,
): TaskRunnerRuntime {
  if (!dispatcher) {
    throw new Error("Task runner command dispatcher is required");
  }
  return { engine, dispatcher };
}

export function createInProcessTaskRunnerRuntime(engine: EnginePort): TaskRunnerRuntime {
  return createTaskRunnerRuntime(
    engine,
    new InProcessRunnerCommandDispatcher(engine),
  );
}
