import type { Logger } from "pino";

import type { SessionDB } from "../db/session_db.js";
import { ClaudeSdkClient } from "../engine/claude_adapter.js";
import type { ClaudeClientEvent } from "../engine/claude_event_mapper.js";
import { ClaudeSessionClientRegistry } from
  "../engine/claude_session_client_registry.js";
import { ClaudeBackgroundTaskLifecycle } from
  "../task/claude_background_task_lifecycle.js";

interface ComposeClaudeRuntimeParams {
  enabled: boolean;
  db: SessionDB;
  sourceNode: string;
  idleTtlMs: number;
  maxEntries: number;
  turnTimeoutMs: number;
  logger: Logger;
  detachedEventSink(
    sessionId: string,
    event: ClaudeClientEvent,
  ): Promise<void>;
}

export interface ClaudeRuntimeComposition {
  registry?: ClaudeSessionClientRegistry;
  backgroundLifecycle?: ClaudeBackgroundTaskLifecycle;
}

/** Keeps the default-off persistent runtime object graph out of legacy composition. */
export async function composeClaudeRuntime(
  params: ComposeClaudeRuntimeParams,
): Promise<ClaudeRuntimeComposition> {
  if (!params.enabled) return {};
  const backgroundLifecycle = new ClaudeBackgroundTaskLifecycle({
    repository: params.db.claudeBackgroundTasks(),
    sourceNode: params.sourceNode,
  });
  const recovered = await backgroundLifecycle.recoverAfterRestart();
  if (recovered > 0) {
    params.logger.warn(
      { count: recovered, nodeId: params.sourceNode },
      "Recovered in-flight Claude background tasks after worker restart",
    );
  }
  const registry = new ClaudeSessionClientRegistry(
    (sessionId) =>
      new ClaudeSdkClient(
        {
          runtimeEventSink: (event) =>
            backgroundLifecycle.observe(sessionId, event),
          detachedEventSink: (event) =>
            params.detachedEventSink(sessionId, event),
          persistentTurnTimeoutMs: params.turnTimeoutMs,
        },
        params.logger,
      ),
    {
      idleTtlMs: params.idleTtlMs,
      maxEntries: params.maxEntries,
      logger: params.logger,
    },
  );
  return { registry, backgroundLifecycle };
}
