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
  readonly eventPersistence: "host" | "runner";
}

export function createTaskRunnerRuntime(
  engine: EnginePort,
  dispatcher: RunnerCommandDispatcher,
  eventPersistence: "host" | "runner" = "host",
): TaskRunnerRuntime {
  if (!dispatcher) {
    throw new Error("Task runner command dispatcher is required");
  }
  return { engine, dispatcher, eventPersistence };
}

export function createInProcessTaskRunnerRuntime(engine: EnginePort): TaskRunnerRuntime {
  return createTaskRunnerRuntime(
    engine,
    new InProcessRunnerCommandDispatcher(engine),
    "host",
  );
}
