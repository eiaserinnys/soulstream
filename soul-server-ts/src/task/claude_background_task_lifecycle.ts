// Over 500 lines: parsing, generation routing and terminal delivery belong to this lifecycle boundary.
import type { Logger } from "pino";

import type { ClaudeClientEvent } from "../engine/claude_client_event.js";
import { readClaudeBackgroundProvenance } from
  "../engine/claude_background_provenance.js";
import { readClaudeSdkSessionMetadata } from
  "../engine/claude_sdk_session_metadata.js";
import {
  attachClaudeBackgroundDeliveryMetadata,
  type ClaudeBackgroundDeliveryMetadata,
} from "../engine/claude_background_delivery_metadata.js";
import type { ClaudeRuntimeHostClient } from "../control_plane/persistence_host_clients.js";
import type {
  ClaudeBackgroundTaskGenerationRow,
  ClaudeBackgroundTerminalStatus,
} from "@soulstream/mcp-contract";
import type {
  RegisterSessionDeliveryParams,
  SessionDeliveryRow,
} from "@soulstream/wire-schema/session-delivery";
import { PersistenceHostRequestError } from
  "../control_plane/persistence_host_transport.js";
import type { ExecutionRegistration } from "./execution_registration.js";

import { buildCanonicalDeliveryPayload } from "@soulstream/wire-schema/delivery";
import {
  buildClaudeBackgroundGenerationIdentity,
  buildClaudeBackgroundResumeId,
  originalClaudeBackgroundToolUseId,
} from "./claude_background_generation_identity.js";
import {
  buildClaudeRuntimeTaskFollowupPrompt,
  buildFollowupKey,
  type PendingRuntimeTaskFollowup,
} from "./claude_runtime_task_followup_prompt.js";
import { CLAUDE_RUNTIME_TASK_FOLLOWUP_SOURCE } from "./claude_runtime_task_followup.js";

/** Wire code the central host route returns for a rejected execution owner. */
const EXECUTION_OWNER_CONFLICT_CODE = "CLAUDE_BACKGROUND_EXECUTION_OWNER_CONFLICT";

interface ClaudeBackgroundTaskLifecycleDeps {
  repository: ClaudeRuntimeHostClient;
  sourceNode: string;
  logger?: Pick<Logger, "warn" | "error">;
  now?: () => Date;
}

/** Persists SDK background lifecycle before the event is exposed to callers. */
export class ClaudeBackgroundTaskLifecycle {
  private readonly now: () => Date;
  private readonly currentGenerations = new Map<string, string>();

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
    if (!parsed || !parsed.sdkSessionId) return true;
    const taskKey = JSON.stringify([sessionId, parsed.sdkSessionId, parsed.taskId]);
    let initiatingToolUseId = parsed.toolUseId;
    if (initiatingToolUseId && (event.type === "claude_runtime_task_started" ||
      event.type === "claude_runtime_task_created")) {
      const originalId = originalClaudeBackgroundToolUseId(initiatingToolUseId);
      try {
        for (let n = 0; ; n += 1) {
          const candidate = n === 0 ? originalId : buildClaudeBackgroundResumeId(originalId, n);
          const row = await this.deps.repository.getGeneration(
            this.deps.sourceNode, sessionId, parsed.sdkSessionId, parsed.taskId, candidate,
          );
          if (!row || row.status === "pending" || row.status === "running") {
            initiatingToolUseId = candidate;
            break;
          }
        }
      } catch (err) {
        this.deps.logger?.warn({ err, sessionId, taskId: parsed.taskId },
          "Claude background generation lookup failed; continuing the turn");
        return true;
      }
      this.currentGenerations.delete(taskKey);
      this.currentGenerations.set(taskKey, initiatingToolUseId);
      if (this.currentGenerations.size > 2_000) {
        this.currentGenerations.delete(this.currentGenerations.keys().next().value!);
      }
    } else {
      const current = this.currentGenerations.get(taskKey);
      if (current && (!initiatingToolUseId ||
        initiatingToolUseId === originalClaudeBackgroundToolUseId(current))) {
        initiatingToolUseId = current;
      }
    }
    if (!initiatingToolUseId && parsed.terminalStatus) {
      const resolved = await this.deps.repository.resolveGeneration(
        this.deps.sourceNode,
        sessionId,
        parsed.sdkSessionId,
        parsed.taskId,
      );
      if (resolved.status !== "resolved") return true;
      initiatingToolUseId = resolved.row.initiating_tool_use_id;
    }
    if (!initiatingToolUseId) return true;
    const identity = buildClaudeBackgroundGenerationIdentity({
      sourceNode: this.deps.sourceNode,
      agentSessionId: sessionId,
      sdkSessionId: parsed.sdkSessionId,
      sdkTaskId: parsed.taskId,
      initiatingToolUseId,
    });
    const timestamp = "timestamp" in event ? event.timestamp : undefined;
    const observedAt = timestamp
      ? new Date(timestamp * 1_000)
      : this.now();
    if (!parsed.terminalStatus) {
      const observation = {
        ...(idempotencyKey ? { idempotencyKey } : {}),
        sourceNode: this.deps.sourceNode,
        sessionId,
        taskId: parsed.taskId,
        sdkSessionId: parsed.sdkSessionId,
        initiatingToolUseId,
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
      };
      let row: ClaudeBackgroundTaskGenerationRow;
      try {
        row = await this.deps.repository.observeGeneration(observation);
      } catch (err) {
        // Retries live in the host client; one failed observation must not end the turn.
        this.deps.logger?.warn(
          { err, sessionId, taskId: parsed.taskId },
          "Claude background runtime observation was not persisted; continuing the turn",
        );
        return true;
      }
      return row.status === "pending" || row.status === "running";
    }

    const terminalRevision =
      parsed.terminalRevision ?? String(observedAt.getTime());
    const delivery = buildDelivery({
      ...identity,
      sessionId,
      sdkSessionId: parsed.sdkSessionId,
      initiatingToolUseId,
      taskId: parsed.taskId,
      terminalRevision,
      status: parsed.terminalStatus,
      closeReason: parsed.closeReason ?? `sdk_${parsed.terminalStatus}`,
      description: parsed.description,
      summary: parsed.summary,
      outputFile: parsed.outputFile,
      toolUseId: originalClaudeBackgroundToolUseId(initiatingToolUseId),
      error: parsed.error,
      createdAt: observedAt,
    });
    let result: Awaited<ReturnType<ClaudeRuntimeHostClient["terminalizeGeneration"]>>;
    try {
      result = await this.deps.repository.terminalizeGeneration({
        ...(idempotencyKey ? { idempotencyKey } : {}),
        sourceNode: this.deps.sourceNode,
        sessionId,
        taskId: parsed.taskId,
        sdkSessionId: parsed.sdkSessionId,
        initiatingToolUseId,
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
    } catch (err) {
      if (!isExecutionOwnerConflict(err)) throw err;
      // The row stays non-terminal either way. Only the owning execution's
      // dead-runner cleanup terminalizes it later; refusing the terminal write
      // must not take the session down with it.
      this.deps.logger?.error(
        {
          err,
          sessionId,
          taskId: parsed.taskId,
          sdkSessionId: parsed.sdkSessionId,
          initiatingToolUseId,
          generationKey: identity.generationKey,
          ...(execution
            ? {
              runnerRegistrationId: execution.registrationId,
              executionCommandId: execution.executionCommandId,
            }
            : {}),
        },
        "Claude background generation terminalize rejected by owner conflict; leaving the turn live",
      );
      return false;
    }
    if (!result.accepted) return false;
    if (!result.delivery) throw new Error("Claude background terminal delivery missing");
    attachClaudeBackgroundDeliveryMetadata(
      event,
      deliveryMetadata(result.delivery, initiatingToolUseId),
    );
    return true;
  }

  async terminalizeOrphanedForNode(params: {
    liveSessionIds: ReadonlySet<string>; updatedBefore: Date; limit: number;
  }): Promise<{ queried: number; closed: number; skippedLive: number; failed: number }> {
    const rows = await this.deps.repository.activeGenerationsForNode({
      sourceNode: this.deps.sourceNode, updatedBefore: params.updatedBefore, limit: params.limit,
    });
    const counts = { queried: rows.length, closed: 0, skippedLive: 0, failed: 0 };
    for (const row of rows) {
      if (params.liveSessionIds.has(row.session_id)) {
        counts.skippedLive += 1;
        continue;
      }
      try {
        const result = await this.deps.repository.terminalizeGeneration({
          sourceNode: row.source_node, sessionId: row.session_id, taskId: row.task_id,
          sdkSessionId: row.sdk_session_id, initiatingToolUseId: row.initiating_tool_use_id,
          generationKey: row.generation_key, relationKey: row.relation_key, completionId: row.completion_id,
          status: "killed", closeReason: "runner_missing",
          terminalRevision: `runner-missing:${row.generation_key}`,
        });
        if (result.accepted) counts.closed += 1;
      } catch (err) {
        counts.failed += 1;
        this.deps.logger?.error({ err, generationKey: row.generation_key }, "orphaned Claude background generation terminalization failed");
      }
    }
    return counts;
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
      toolUseId: originalClaudeBackgroundToolUseId(row.initiating_tool_use_id),
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

function deliveryMetadata(
  row: SessionDeliveryRow,
  initiatingToolUseId: string,
): ClaudeBackgroundDeliveryMetadata {
  if (!row.completion_id || !row.producer_terminal_revision) {
    throw new Error(`Background delivery ${row.delivery_id} is missing identity metadata`);
  }
  return {
    initiatingToolUseId,
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

function isExecutionOwnerConflict(error: unknown): boolean {
  return error instanceof PersistenceHostRequestError
    && error.status === 409
    && error.code === EXECUTION_OWNER_CONFLICT_CODE;
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
