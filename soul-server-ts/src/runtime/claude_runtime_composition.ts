import { randomUUID } from "node:crypto";

import type { Logger } from "pino";
import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";

import type { Env } from "../config.js";
import { ClaudeAuthService, FileClaudeAuthTokenStore } from "../auth/claude_auth.js";
import { ClaudeAccountService } from "../claude_accounts/index.js";
import type { AgentRegistry } from "../agent_registry.js";
import type { SessionDB } from "../db/session_db.js";
import type { SessionDeliveryRow } from "../db/session_db_types.js";
import type { ModelCatalog } from "../model_catalog.js";
import { ClaudeSdkClient } from "../engine/claude_adapter.js";
import { ClaudeDeliveryTranscriptReceiptReader } from
  "../engine/claude_delivery_transcript_receipt.js";
import type { ClaudeClientEvent } from "../engine/claude_client_event.js";
import type { ClaudeAccountTurnPort } from "../engine/claude_account_pool.js";
import { ClaudeSessionClientRegistry } from
  "../engine/claude_session_client_registry.js";
import { ClaudeBackgroundTaskLifecycle } from
  "../task/claude_background_task_lifecycle.js";
import { ClaudeBackgroundGenerationStartupRecovery } from
  "../task/claude_background_generation_startup_recovery.js";
import { ChildCompletionConsumptionRecorder } from
  "../task/child_completion_consumption.js";
import { QueuedDeliveryTranscriptRecovery } from
  "../task/queued_delivery_transcript_recovery.js";
import { ClaudeRuntimeStartupRecovery } from
  "./claude_runtime_startup_recovery.js";

export function composeClaudeAccountServices(
  env: Pick<Env, "CLAUDE_AUTH_TOKEN_PATH" | "CLAUDE_ACCOUNT_POOL_ENABLED" | "CLAUDE_ACCOUNTS_DIR">,
  logger: Logger,
): {
  claudeAuth: ClaudeAuthService;
  claudeAccounts: ClaudeAccountService | undefined;
} {
  return {
    claudeAuth: new ClaudeAuthService({
      store: new FileClaudeAuthTokenStore(env.CLAUDE_AUTH_TOKEN_PATH),
    }, logger),
    claudeAccounts: env.CLAUDE_ACCOUNT_POOL_ENABLED && env.CLAUDE_ACCOUNTS_DIR
      ? new ClaudeAccountService({ accountsDir: env.CLAUDE_ACCOUNTS_DIR })
      : undefined,
  };
}

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
  redeliverContent(row: SessionDeliveryRow): Promise<void>;
  resolveWorktreeWorkspace?(worktreeId: string): Promise<string>;
  claudeAccountTurnPort?: ClaudeAccountTurnPort;
}

export interface ClaudeRuntimeComposition {
  registry?: ClaudeSessionClientRegistry;
  backgroundLifecycle?: ClaudeBackgroundTaskLifecycle;
  childCompletionConsumption?: ChildCompletionConsumptionRecorder;
  startupRecovery?: ClaudeRuntimeStartupRecovery;
  transcriptReceipt?: Pick<
    ClaudeDeliveryTranscriptReceiptReader,
    "inspectInput" | "inspectNativeTaskNotification"
  >;
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
    ...(params.resolveWorktreeWorkspace
      ? { resolveWorktreeWorkspace: params.resolveWorktreeWorkspace }
      : {}),
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
      redeliverContent: params.redeliverContent,
      logger: params.logger,
    },
    `queued-recovery:${params.sourceNode}:${randomUUID()}`,
  );
  const backgroundLifecycle = new ClaudeBackgroundTaskLifecycle({
    repository: params.db.claudeBackgroundTasks(),
    sourceNode: params.sourceNode,
    logger: params.logger,
  });
  const backgroundGenerationRecovery = new ClaudeBackgroundGenerationStartupRecovery({
    repository: params.db.claudeBackgroundTasks(),
    lifecycle: backgroundLifecycle,
    recordRelationConsumed: (input) =>
      deliveryRepository.recordRelationConsumed(input),
    sourceNode: params.sourceNode,
    logger: params.logger,
    sessionStore: params.sessionStore,
    getSession: (sessionId) => params.db.getSession(sessionId),
    getAgent: (agentId) => params.agentRegistry.get(agentId),
    ...(params.resolveWorktreeWorkspace
      ? { resolveWorktreeWorkspace: params.resolveWorktreeWorkspace }
      : {}),
    getModelPresetBackend: (presetId) => {
      try {
        return params.modelCatalog.resolve(presetId).backend;
      } catch {
        return undefined;
      }
    },
  });
  const startupRecovery = new ClaudeRuntimeStartupRecovery({
    recoverBackgroundGenerations: () =>
      backgroundGenerationRecovery.recoverAfterNodeRestart(),
    recoverQueuedDeliveries: () =>
      queuedDeliveryRecovery.recoverAfterNodeRestart(params.sourceNode),
    logger: params.logger,
    nodeId: params.sourceNode,
  });
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
      ...(params.claudeAccountTurnPort
        ? {
            onClientClosed: async (sessionId: string) => {
              await params.claudeAccountTurnPort!.release({
                session_id: sessionId,
                clear_all: true,
              });
            },
          }
        : {}),
    },
  );
  return {
    registry,
    backgroundLifecycle,
    transcriptReceipt,
    childCompletionConsumption: new ChildCompletionConsumptionRecorder(
      deliveryRepository,
    ),
    startupRecovery,
  };
}

export function createClaudeAccountPoolRegistry(params: {
  claudeAccountTurnPort: ClaudeAccountTurnPort;
  idleTtlMs: number;
  maxEntries: number;
  logger: Logger;
}): ClaudeSessionClientRegistry {
  return new ClaudeSessionClientRegistry(
    () => new ClaudeSdkClient({}, params.logger),
    {
      idleTtlMs: params.idleTtlMs,
      maxEntries: params.maxEntries,
      logger: params.logger,
      onClientClosed: async (sessionId) => {
        await params.claudeAccountTurnPort.release({
          session_id: sessionId,
          clear_all: true,
        });
      },
    },
  );
}
