import { randomUUID } from "node:crypto";

import type { Logger } from "pino";
import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";

import type { AgentRegistry } from "../agent_registry.js";
import type { SessionDB } from "../db/session_db.js";
import type { ModelCatalog } from "../model_catalog.js";
import { ClaudeSdkClient } from "../engine/claude_adapter.js";
import { ClaudeDeliveryTranscriptReceiptReader } from
  "../engine/claude_delivery_transcript_receipt.js";
import type { ClaudeClientEvent } from "../engine/claude_event_mapper.js";
import { ClaudeSessionClientRegistry } from
  "../engine/claude_session_client_registry.js";
import { ClaudeBackgroundTaskLifecycle } from
  "../task/claude_background_task_lifecycle.js";
import { ChildCompletionConsumptionRecorder } from
  "../task/child_completion_consumption.js";
import { QueuedDeliveryTranscriptRecovery } from
  "../task/queued_delivery_transcript_recovery.js";
import { ClaudeRuntimeStartupRecovery } from
  "./claude_runtime_startup_recovery.js";

interface ComposeClaudeRuntimeParams {
  enabled: boolean;
  db: SessionDB;
  agentRegistry: AgentRegistry;
  modelCatalog: Pick<ModelCatalog, "resolve">;
  sessionStore: SessionStore;
  sourceNode: string;
  idleTtlMs: number;
  maxEntries: number;
  turnInactivityTimeoutMs: number;
  logger: Logger;
  detachedEventSink(
    sessionId: string,
    event: ClaudeClientEvent,
  ): Promise<void>;
}

export interface ClaudeRuntimeComposition {
  registry?: ClaudeSessionClientRegistry;
  backgroundLifecycle?: ClaudeBackgroundTaskLifecycle;
  childCompletionConsumption?: ChildCompletionConsumptionRecorder;
  startupRecovery?: ClaudeRuntimeStartupRecovery;
}

/** Keeps the persistent runtime object graph out of explicit kill-switch mode. */
export async function composeClaudeRuntime(
  params: ComposeClaudeRuntimeParams,
): Promise<ClaudeRuntimeComposition> {
  if (!params.enabled) return {};
  const deliveryRepository = params.db.sessionDeliveries();
  const transcriptReceipt = new ClaudeDeliveryTranscriptReceiptReader({
    sourceNode: params.sourceNode,
    sessionStore: params.sessionStore,
    getSession: (sessionId) => params.db.getSession(sessionId),
    getAgent: (agentId) => params.agentRegistry.get(agentId),
    getModelPresetBackend: (presetId) => {
      try {
        return params.modelCatalog.resolve(presetId).backend;
      } catch {
        return undefined;
      }
    },
  });
  const queuedDeliveryRecovery = new QueuedDeliveryTranscriptRecovery(
    {
      deliveryRepository,
      recoveryRepository: deliveryRepository.recovery,
      transcriptReceipt,
      logger: params.logger,
    },
    `queued-recovery:${params.sourceNode}:${randomUUID()}`,
  );
  const backgroundLifecycle = new ClaudeBackgroundTaskLifecycle({
    repository: params.db.claudeBackgroundTasks(),
    sourceNode: params.sourceNode,
  });
  const startupRecovery = new ClaudeRuntimeStartupRecovery({
    recoverQueuedDeliveries: () =>
      queuedDeliveryRecovery.recoverAfterNodeRestart(params.sourceNode),
    recoverBackgroundTasks: () => backgroundLifecycle.recoverAfterRestart(),
    logger: params.logger,
    nodeId: params.sourceNode,
  });
  await startupRecovery.start();
  const registry = new ClaudeSessionClientRegistry(
    (sessionId) =>
      new ClaudeSdkClient(
        {
          runtimeEventSink: (event) =>
            backgroundLifecycle.observe(sessionId, event),
          detachedEventSink: (event) =>
            params.detachedEventSink(sessionId, event),
          persistentTurnInactivityTimeoutMs: params.turnInactivityTimeoutMs,
        },
        params.logger,
      ),
    {
      idleTtlMs: params.idleTtlMs,
      maxEntries: params.maxEntries,
      logger: params.logger,
    },
  );
  return {
    registry,
    backgroundLifecycle,
    childCompletionConsumption: new ChildCompletionConsumptionRecorder(
      deliveryRepository,
    ),
    startupRecovery,
  };
}
