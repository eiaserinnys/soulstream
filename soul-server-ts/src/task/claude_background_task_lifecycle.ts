import type { ClaudeClientEvent } from "../engine/claude_event_mapper.js";
import { readClaudeBackgroundProvenance } from
  "../engine/claude_background_provenance.js";
import { readClaudeSdkSessionMetadata } from
  "../engine/claude_sdk_session_metadata.js";
import {
  attachClaudeBackgroundDeliveryMetadata,
  type ClaudeBackgroundDeliveryMetadata,
} from "../engine/claude_background_delivery_metadata.js";
import type {
  ClaudeBackgroundTaskRepository,
  ClaudeBackgroundTaskGenerationRow,
  ClaudeBackgroundTerminalStatus,
} from "../db/repositories/claude_background_task_repository.js";
import type {
  RegisterSessionDeliveryParams,
  SessionDeliveryRow,
} from "../db/session_db_types.js";
import type { ExecutionRegistration } from "./execution_registration.js";

import { buildCanonicalDeliveryPayload } from "./delivery_payload.js";
import { buildClaudeBackgroundGenerationIdentity } from
  "./claude_background_generation_identity.js";
import {
  buildClaudeRuntimeTaskFollowupPrompt,
  buildFollowupKey,
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

  async observe(
    sessionId: string,
    event: ClaudeClientEvent,
    idempotencyKey?: string,
    execution?: ExecutionRegistration,
  ): Promise<boolean> {
    const parsed = parseBackgroundEvent(event);
    if (!parsed || !parsed.sdkSessionId || !parsed.toolUseId) return true;
    const identity = buildClaudeBackgroundGenerationIdentity({
      sourceNode: this.deps.sourceNode,
      agentSessionId: sessionId,
      sdkSessionId: parsed.sdkSessionId,
      sdkTaskId: parsed.taskId,
      initiatingToolUseId: parsed.toolUseId,
    });
    const timestamp = "timestamp" in event ? event.timestamp : undefined;
    const observedAt = timestamp
      ? new Date(timestamp * 1_000)
      : this.now();
    if (!parsed.terminalStatus) {
      const row = await this.deps.repository.observeGeneration({
        ...(idempotencyKey ? { idempotencyKey } : {}),
        sourceNode: this.deps.sourceNode,
        sessionId,
        taskId: parsed.taskId,
        sdkSessionId: parsed.sdkSessionId,
        initiatingToolUseId: parsed.toolUseId,
        ...identity,
        ...(execution
          ? {
            runnerRegistrationId: execution.registrationId,
            executionCommandId: execution.executionCommandId,
          }
          : {}),
        status: parsed.status,
        description: parsed.description,
        summary: parsed.summary,
        outputFile: parsed.outputFile,
        observedAt,
      });
      return row.status === "pending" || row.status === "running";
    }

    const terminalRevision =
      parsed.terminalRevision ?? String(observedAt.getTime());
    const delivery = buildDelivery({
      ...identity,
      sessionId,
      sdkSessionId: parsed.sdkSessionId,
      initiatingToolUseId: parsed.toolUseId,
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
    const result = await this.deps.repository.terminalizeGeneration({
      ...(idempotencyKey ? { idempotencyKey } : {}),
      sourceNode: this.deps.sourceNode,
      sessionId,
      taskId: parsed.taskId,
      sdkSessionId: parsed.sdkSessionId,
      initiatingToolUseId: parsed.toolUseId,
      ...identity,
      ...(execution
        ? {
          runnerRegistrationId: execution.registrationId,
          executionCommandId: execution.executionCommandId,
        }
        : {}),
      status: parsed.terminalStatus,
      closeReason: parsed.closeReason ?? `sdk_${parsed.terminalStatus}`,
      terminalRevision,
      description: parsed.description,
      summary: parsed.summary,
      outputFile: parsed.outputFile,
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

  async terminalizeDeadRunner(
    sessionId: string,
    execution: ExecutionRegistration,
  ): Promise<number> {
    let recovered = 0;
    for (;;) {
      const active = await this.deps.repository.activeGenerationsForExecution(
        this.deps.sourceNode,
        sessionId,
        execution.registrationId,
        execution.executionCommandId,
      );
      if (active.length === 0) return recovered;
      for (const row of active) {
        if (await this.terminalizeDeadRunnerRow(row)) recovered += 1;
      }
    }
  }

  private async terminalizeDeadRunnerRow(
    row: ClaudeBackgroundTaskGenerationRow,
  ): Promise<boolean> {
    const createdAt = this.now();
    const terminalRevision = `runner-dead:${row.generation_key}`;
    const delivery = buildDelivery({
      generationKey: row.generation_key,
      relationKey: row.relation_key,
      completionId: row.completion_id,
      deliveryId: buildClaudeBackgroundGenerationIdentity({
        sourceNode: row.source_node,
        agentSessionId: row.session_id,
        sdkSessionId: row.sdk_session_id,
        sdkTaskId: row.task_id,
        initiatingToolUseId: row.initiating_tool_use_id,
      }).deliveryId,
      sessionId: row.session_id,
      sdkSessionId: row.sdk_session_id,
      initiatingToolUseId: row.initiating_tool_use_id,
      taskId: row.task_id,
      terminalRevision,
      status: "killed",
      closeReason: "runner_dead",
      description: row.description ?? undefined,
      summary: row.summary ?? undefined,
      outputFile: row.output_file ?? undefined,
      toolUseId: row.initiating_tool_use_id,
      createdAt,
    });
    const result = await this.deps.repository.terminalizeGeneration({
      sourceNode: row.source_node,
      sessionId: row.session_id,
      taskId: row.task_id,
      sdkSessionId: row.sdk_session_id,
      initiatingToolUseId: row.initiating_tool_use_id,
      generationKey: row.generation_key,
      relationKey: row.relation_key,
      completionId: row.completion_id,
      ...(row.runner_registration_id && row.execution_command_id
        ? {
          runnerRegistrationId: row.runner_registration_id,
          executionCommandId: row.execution_command_id,
        }
        : {}),
      status: "killed",
      closeReason: "runner_dead",
      terminalRevision,
      description: row.description ?? undefined,
      summary: row.summary ?? undefined,
      outputFile: row.output_file ?? undefined,
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
  const sdkSessionId = "sessionId" in event && event.sessionId
    ? event.sessionId
    : readClaudeSdkSessionMetadata(event)?.sessionId;
  switch (event.type) {
    case "claude_runtime_task_started":
    case "claude_runtime_task_created":
    case "claude_runtime_task_progress":
      return {
        taskId: event.taskId,
        sdkSessionId,
        status: event.type === "claude_runtime_task_created" ? "pending" : "running",
        description: event.description,
        summary: event.type === "claude_runtime_task_progress" ? event.summary : undefined,
        toolUseId: "toolUseId" in event ? event.toolUseId : undefined,
      };
    case "claude_runtime_task_completed":
      return {
        taskId: event.taskId,
        sdkSessionId,
        terminalStatus: "completed",
        description: event.description,
        toolUseId: undefined,
      };
    case "claude_runtime_task_notification":
      return {
        taskId: event.taskId,
        sdkSessionId,
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
        sdkSessionId,
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
  generationKey: string;
  relationKey: string;
  completionId: string;
  deliveryId: string;
  sessionId: string;
  sdkSessionId: string;
  initiatingToolUseId: string;
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
  const item: PendingRuntimeTaskFollowup = {
    generationKey: input.generationKey,
    relationKey: input.relationKey,
    completionId: input.completionId,
    deliveryId: input.deliveryId,
    sdkSessionId: input.sdkSessionId,
    initiatingToolUseId: input.initiatingToolUseId,
    taskId: input.taskId,
    status: input.status,
    description: input.description,
    summary: input.summary,
    outputFile: input.outputFile,
    toolUseId: input.toolUseId,
    error: input.error,
    terminalRevision: input.terminalRevision,
    firstSeen: 0,
  };
  const canonical = buildCanonicalDeliveryPayload({
    text: buildClaudeRuntimeTaskFollowupPrompt([item]),
    user: "system",
    source: CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE,
    completionId: input.completionId,
    relationKey: input.relationKey,
    callerInfo: { source: "system", display_name: "Soulstream" },
    followupKey: buildFollowupKey(input.sessionId, [item]),
    followupAttempt: 1,
    followupTaskIds: [input.taskId],
  });
  return {
    deliveryId: input.deliveryId,
    targetSessionId: input.sessionId,
    relationKey: input.relationKey,
    completionId: input.completionId,
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
