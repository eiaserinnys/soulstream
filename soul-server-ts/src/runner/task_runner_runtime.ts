import type { EnginePort } from "../engine/protocol.js";
import type { RunnerIsolationIdentity } from "../security/session_isolation_turn.js";

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
  /**
   * 이 러너가 어떤 보안 조건(tier·정책 digest·부착 워크트리)으로 떠 있는지.
   * 미설정은 full 취급 — 기존 러너와 in-process 러너의 기본값이다.
   */
  readonly isolation?: RunnerIsolationIdentity;
}

export function createTaskRunnerRuntime(
  engine: EnginePort,
  dispatcher: RunnerCommandDispatcher,
  eventPersistence: "host" | "runner" = "host",
  isolation?: RunnerIsolationIdentity,
): TaskRunnerRuntime {
  if (!dispatcher) {
    throw new Error("Task runner command dispatcher is required");
  }
  return {
    engine,
    dispatcher,
    eventPersistence,
    ...(isolation ? { isolation } : {}),
  };
}

export function createInProcessTaskRunnerRuntime(engine: EnginePort): TaskRunnerRuntime {
  return createTaskRunnerRuntime(
    engine,
    new InProcessRunnerCommandDispatcher(engine),
    "host",
  );
}
