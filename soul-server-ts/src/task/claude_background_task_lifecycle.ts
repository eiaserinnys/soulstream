import type { ClaudeClientEvent } from "../engine/claude_event_mapper.js";
import { readClaudeBackgroundProvenance } from
  "../engine/claude_background_provenance.js";
import {
  attachClaudeBackgroundDeliveryMetadata,
  type ClaudeBackgroundDeliveryMetadata,
} from "../engine/claude_background_delivery_metadata.js";
import type {
  ClaudeBackgroundTaskRepository,
  ClaudeBackgroundTaskRow,
  ClaudeBackgroundTerminalStatus,
} from "../db/repositories/claude_background_task_repository.js";
import type {
  RegisterSessionDeliveryParams,
  SessionDeliveryRow,
} from "../db/session_db_types.js";

import {
  buildDeterministicDeliveryIdentity,
} from "./delivery_identity.js";
import { buildCanonicalDeliveryPayload } from "./delivery_payload.js";
import {
  buildClaudeRuntimeTaskFollowupPrompt,
  type PendingRuntimeTaskFollowup,
} from "./claude_runtime_task_followup_prompt.js";
import { CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE } from "./claude_runtime_task_followup.js";

interface ClaudeBackgroundTaskLifecycleDeps {
  repository: ClaudeBackgroundTaskRepository;
  sourceNode: string;
  now?: () => Date;
}

/** Persists SDK background lifecycle before the event is exposed to callers. */
export class ClaudeBackgroundTaskLifecycle {
  private readonly now: () => Date;

  constructor(private readonly deps: ClaudeBackgroundTaskLifecycleDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async observe(sessionId: string, event: ClaudeClientEvent): Promise<boolean> {
    const parsed = parseBackgroundEvent(event);
    if (!parsed) return true;
    const timestamp = "timestamp" in event ? event.timestamp : undefined;
    const observedAt = timestamp
      ? new Date(timestamp * 1_000)
      : this.now();
    if (!parsed.terminalStatus) {
      const row = await this.deps.repository.observe({
        sourceNode: this.deps.sourceNode,
        sessionId,
        taskId: parsed.taskId,
        sdkSessionId: parsed.sdkSessionId,
        status: parsed.status,
        description: parsed.description,
        summary: parsed.summary,
        outputFile: parsed.outputFile,
        toolUseId: parsed.toolUseId,
        observedAt,
      });
      return row.status === "pending" || row.status === "running";
    }

    const terminalRevision =
      parsed.terminalRevision ?? String(observedAt.getTime());
    const delivery = buildDelivery({
      sessionId,
      taskId: parsed.taskId,
      terminalRevision,
      status: parsed.terminalStatus,
      closeReason: parsed.closeReason ?? `sdk_${parsed.terminalStatus}`,
      description: parsed.description,
      summary: parsed.summary,
      outputFile: parsed.outputFile,
      toolUseId: parsed.toolUseId,
      error: parsed.error,
      createdAt: observedAt,
    });
    const result = await this.deps.repository.terminalize({
      sourceNode: this.deps.sourceNode,
      sessionId,
      taskId: parsed.taskId,
      sdkSessionId: parsed.sdkSessionId,
      status: parsed.terminalStatus,
      closeReason: parsed.closeReason ?? `sdk_${parsed.terminalStatus}`,
      terminalRevision,
      description: parsed.description,
      summary: parsed.summary,
      outputFile: parsed.outputFile,
      toolUseId: parsed.toolUseId,
      observedAt,
      delivery,
    });
    if (!result.accepted) return false;
    attachClaudeBackgroundDeliveryMetadata(
      event,
      deliveryMetadata(result.delivery),
    );
    return true;
  }

  async recoverAfterRestart(): Promise<number> {
    let recovered = 0;
    for (;;) {
      const active = await this.deps.repository.activeForNode(
        this.deps.sourceNode,
      );
      if (active.length === 0) return recovered;
      for (const row of active) {
        if (await this.terminalizeRestart(row)) recovered += 1;
      }
    }
  }

  private async terminalizeRestart(row: ClaudeBackgroundTaskRow): Promise<boolean> {
    const createdAt = this.now();
    const terminalRevision = `restart:${createdAt.getTime()}`;
    const delivery = buildDelivery({
      sessionId: row.session_id,
      taskId: row.task_id,
      terminalRevision,
      status: "killed",
      closeReason: "worker_restart",
      description: row.description ?? undefined,
      summary: row.summary ?? undefined,
      outputFile: row.output_file ?? undefined,
      toolUseId: row.tool_use_id ?? undefined,
      createdAt,
    });
    const result = await this.deps.repository.terminalize({
      sourceNode: row.source_node,
      sessionId: row.session_id,
      taskId: row.task_id,
      sdkSessionId: row.sdk_session_id ?? undefined,
      status: "killed",
      closeReason: "worker_restart",
      terminalRevision,
      description: row.description ?? undefined,
      summary: row.summary ?? undefined,
      outputFile: row.output_file ?? undefined,
      toolUseId: row.tool_use_id ?? undefined,
      observedAt: createdAt,
      delivery,
    });
    return result.accepted;
  }
}

interface ParsedBackgroundEvent {
  taskId: string;
  sdkSessionId?: string;
  status?: "pending" | "running";
  terminalStatus?: ClaudeBackgroundTerminalStatus;
  closeReason?: string;
  terminalRevision?: string;
  description?: string;
  summary?: string;
  outputFile?: string;
  toolUseId?: string;
  error?: string;
}

function parseBackgroundEvent(event: ClaudeClientEvent): ParsedBackgroundEvent | null {
  if (
    !readClaudeBackgroundProvenance(event) &&
    !(
      event.type === "claude_runtime_task_updated" &&
      event.patch.is_backgrounded === true
    )
  ) {
    return null;
  }
  switch (event.type) {
    case "claude_runtime_task_started":
    case "claude_runtime_task_created":
    case "claude_runtime_task_progress":
      return {
        taskId: event.taskId,
        sdkSessionId: event.sessionId,
        status: event.type === "claude_runtime_task_created" ? "pending" : "running",
        description: event.description,
        summary: event.type === "claude_runtime_task_progress" ? event.summary : undefined,
        toolUseId: "toolUseId" in event ? event.toolUseId : undefined,
      };
    case "claude_runtime_task_completed":
      return {
        taskId: event.taskId,
        sdkSessionId: event.sessionId,
        terminalStatus: "completed",
        description: event.description,
      };
    case "claude_runtime_task_notification":
      return {
        taskId: event.taskId,
        sdkSessionId: event.sessionId,
        terminalStatus: event.status,
        closeReason: `sdk_${event.status}`,
        summary: event.summary,
        outputFile: event.outputFile,
        toolUseId: event.toolUseId,
      };
    case "claude_runtime_task_updated": {
      const status = asTerminalStatus(event.patch.status);
      return {
        taskId: event.taskId,
        sdkSessionId: event.sessionId,
        ...(status ? { terminalStatus: status } : { status: "running" }),
        closeReason: asString(event.patch.close_reason),
        terminalRevision: revision(event.patch.end_time),
        description: asString(event.patch.description),
        summary: asString(event.patch.summary),
        outputFile: asString(event.patch.output_file),
        toolUseId: asString(event.patch.tool_use_id),
        error: asString(event.patch.error),
      };
    }
    default:
      return null;
  }
}

function buildDelivery(input: {
  sessionId: string;
  taskId: string;
  terminalRevision: string;
  status: ClaudeBackgroundTerminalStatus;
  closeReason: string;
  description?: string;
  summary?: string;
  outputFile?: string;
  toolUseId?: string;
  error?: string;
  createdAt: Date;
}): RegisterSessionDeliveryParams {
  const relationKey = `claude_runtime:${input.sessionId}:${input.taskId}`;
  const identity = buildDeterministicDeliveryIdentity({
    targetSessionId: input.sessionId,
    relationKey,
    intent: "runtime_followup",
  });
  const item: PendingRuntimeTaskFollowup = {
    taskId: input.taskId,
    status: input.status,
    description: input.description,
    summary: input.summary,
    outputFile: input.outputFile,
    toolUseId: input.toolUseId,
    error: input.error,
    terminalRevision: input.terminalRevision,
    firstSeen: 0,
    inlineObserved: false,
  };
  const canonical = buildCanonicalDeliveryPayload({
    text: buildClaudeRuntimeTaskFollowupPrompt([item]),
    user: "system",
    source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
    completionId: identity.completionId,
    relationKey,
    callerInfo: { source: "system", display_name: "Soulstream" },
    followupTaskIds: [input.taskId],
  });
  return {
    deliveryId: identity.deliveryId,
    targetSessionId: input.sessionId,
    relationKey,
    completionId: identity.completionId,
    intent: "runtime_followup",
    source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
    producerKind: "claude_background_task",
    producerId: input.taskId,
    producerTerminalRevision: input.terminalRevision,
    payloadHash: canonical.payloadHash,
    payload: canonical.payload,
    createdAt: input.createdAt,
  };
}

function deliveryMetadata(row: SessionDeliveryRow): ClaudeBackgroundDeliveryMetadata {
  if (!row.completion_id || !row.producer_terminal_revision) {
    throw new Error(`Background delivery ${row.delivery_id} is missing identity metadata`);
  }
  return {
    deliveryId: row.delivery_id,
    completionId: row.completion_id,
    relationKey: row.relation_key,
    producerTerminalRevision: row.producer_terminal_revision,
    deliveryCreatedAt: row.created_at.toISOString(),
    source: row.source,
    storedPayload: row.payload,
    storedPayloadHash: row.payload_hash,
  };
}

function asTerminalStatus(value: unknown): ClaudeBackgroundTerminalStatus | undefined {
  return value === "completed" ||
    value === "failed" ||
    value === "stopped" ||
    value === "killed"
    ? value
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function revision(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : asString(value);
}
