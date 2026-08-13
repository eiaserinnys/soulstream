import type { RunnerInventory } from "@soulstream/wire-schema";
import type { Logger } from "pino";
import { WebSocket } from "ws";

import type { SessionDB } from "../db/session_db.js";
import { SessionListCommands } from "./session_list_commands.js";

const INITIAL_REPORT_MAX_ATTEMPTS = 5;
const INITIAL_REPORT_BASE_DELAY_MS = 100;

export async function sendInitialRunnerState(params: {
  ws: WebSocket;
  nodeId: string;
  supportsRunnerInventory: boolean;
  sessionDb: SessionDB | undefined;
  listRunningSessionIds: () => Promise<string[]>;
  isCurrentConnection: () => boolean;
  send: (data: unknown) => Promise<void>;
  logger: Logger;
}): Promise<void> {
  if (!params.supportsRunnerInventory && !params.sessionDb) {
    params.logger.warn("sessionDb dependency missing — initial sessions_update skipped");
    return;
  }

  const label = params.supportsRunnerInventory
    ? "initial runner inventory"
    : "initial sessions_update";
  for (let attempt = 1; attempt <= INITIAL_REPORT_MAX_ATTEMPTS; attempt += 1) {
    if (!isOpen(params)) return;
    try {
      const runningSessionIds = await params.listRunningSessionIds();
      const report = params.supportsRunnerInventory
        ? runnerInventory(runningSessionIds)
        : await new SessionListCommands(params.sessionDb, params.nodeId).listSessions({
          requestId: "",
          runningSessionIds,
        });
      if (!isOpen(params)) return;
      await params.send(report);
      return;
    } catch (err) {
      if (!isOpen(params)) return;
      if (attempt === INITIAL_REPORT_MAX_ATTEMPTS) {
        params.logger.error(
          { err, attempts: attempt, nodeId: params.nodeId },
          `${label} retry limit exhausted`,
        );
        return;
      }
      const delayMs = INITIAL_REPORT_BASE_DELAY_MS * 2 ** (attempt - 1);
      params.logger.warn(
        { err, attempt, delayMs, nodeId: params.nodeId },
        `${label} failed — retrying on current connection`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function isOpen(params: {
  ws: WebSocket;
  isCurrentConnection: () => boolean;
}): boolean {
  return params.isCurrentConnection() && params.ws.readyState === WebSocket.OPEN;
}

function runnerInventory(runningSessionIds: string[]): RunnerInventory {
  return {
    type: "runner_inventory",
    running_session_ids: runningSessionIds,
    requestId: "",
  };
}
