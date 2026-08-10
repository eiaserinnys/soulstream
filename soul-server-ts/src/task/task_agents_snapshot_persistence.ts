import type { Logger } from "pino";

import type { EventPersistence } from "../db/event_persistence.js";
import type {
  EngineRunStateSnapshot,
  EngineSessionItemsSnapshot,
} from "../engine/protocol.js";

import type { Task } from "./task_models.js";

export interface TaskAgentsSnapshotPersistenceDeps {
  persistence: EventPersistence;
  logger: Logger;
}

/**
 * OpenAI Agents SDK snapshot persistence.
 *
 * Owns the write-side metadata contract for Agents resume/recovery:
 * runtime Task fields, metadata entry replacement, and DB update failure isolation.
 */
export class TaskAgentsSnapshotPersistence {
  constructor(private readonly deps: TaskAgentsSnapshotPersistenceDeps) {}

  async persistRunStateSnapshot(
    task: Task,
    snapshot: EngineRunStateSnapshot,
    idempotencyKey?: string,
  ): Promise<void> {
    if (snapshot.backendId !== "openai-agents") return;

    task.agentsRunState = snapshot.serialized ?? undefined;
    task.agentsPendingApprovalId = snapshot.pendingApprovalId ?? undefined;
    task.agentsPreviousResponseId = snapshot.previousResponseId ?? undefined;
    task.agentsConversationId = snapshot.conversationId ?? undefined;
    task.agentsRunStateSchemaVersion = snapshot.schemaVersion ?? undefined;

    const entry = {
      type: "agents_run_state",
      value: {
        backend: "openai-agents",
        serialized: snapshot.serialized,
        pendingApprovalId: snapshot.pendingApprovalId ?? null,
        previousResponseId: snapshot.previousResponseId ?? null,
        conversationId: snapshot.conversationId ?? null,
        schemaVersion: snapshot.schemaVersion ?? null,
        updatedAt: new Date().toISOString(),
      },
    };
    const metadata = replaceMetadataEntry(task.metadata, entry);
    task.metadata = metadata;
    try {
      await this.deps.persistence.enqueueMetadataEffect(task.agentSessionId, entry, {
        replaceExistingType: "agents_run_state",
        ...(idempotencyKey ? { semanticDedupeKey: idempotencyKey } : {}),
      });
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "agents_run_state metadata update failed",
      );
      if (idempotencyKey) throw err;
    }
  }

  async persistSessionItemsSnapshot(
    task: Task,
    snapshot: EngineSessionItemsSnapshot,
    idempotencyKey?: string,
  ): Promise<void> {
    if (snapshot.backendId !== "openai-agents") return;

    task.agentsSessionItems = snapshot.items;
    const entry = {
      type: "agents_session_items",
      value: {
        backend: "openai-agents",
        items: snapshot.items,
        updatedAt: new Date().toISOString(),
      },
    };
    const metadata = replaceMetadataEntry(task.metadata, entry);
    task.metadata = metadata;
    try {
      await this.deps.persistence.enqueueMetadataEffect(task.agentSessionId, entry, {
        replaceExistingType: "agents_session_items",
        ...(idempotencyKey ? { semanticDedupeKey: idempotencyKey } : {}),
      });
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: task.agentSessionId },
        "agents_session_items metadata update failed",
      );
      if (idempotencyKey) throw err;
    }
  }
}

function replaceMetadataEntry(
  metadata: Array<Record<string, unknown>> | undefined,
  entry: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const type = entry.type;
  const next = (metadata ?? []).filter((item) => item.type !== type);
  next.push(entry);
  return next;
}
