import type { NodeRegistryEvent } from "../node/registry.js";
import {
  readPersistentInstructions,
  type PersistentInstructionsApplyPayload,
} from "@soulstream/wire-schema/persistent-session-instructions";
import { readPersistentEnabled } from
  "@soulstream/wire-schema/persistent-session-settings";
import type { RuntimeSessionEventHub } from "../runtime/session_event_hub.js";
import type {
  InMemorySseReplayBroadcaster,
  SessionStreamEvent,
} from "../sse/replay_broadcaster.js";
import type { SessionStoryFoldService } from
  "./session_story_fold_service.js";
import type {
  TurnSummaryConfig,
  TurnSummaryConfigService,
  TurnSummaryLogger,
} from "./turn_summary_config.js";
import {
  summaryDedupeKey,
  type TurnSummaryRepositoryPort,
  type TurnSummaryTurn,
} from "./turn_summary_repository.js";
import type {
  TurnSummarizer,
  TurnSummaryResult,
} from "./turn_summarizer.js";
import { TurnSummaryProviderUnavailableError } from
  "./turn_summary_provider_router.js";
import type { TurnSummaryStartEvidence } from
  "./turn_summary_completion_evidence.js";

export interface TurnSummaryCompleteJob {
  readonly nodeId: string;
  readonly sessionId: string;
  readonly completeEventId: number;
}

type TurnSummarySkipReason =
  | "turn_not_reconstructable"
  | "cache_keepalive"
  | "internal_summary"
  | "agent_origin"
  | "excluded_folder"
  | "system_notification"
  | "delegated_terminal_failure"
  | "delegated_completion_without_new_input"
  | "already_summarized"
  | "session_not_summarizable";

export const PERSISTENT_INSTRUCTION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "standing_instructions"],
  properties: {
    summary: { type: "string" },
    standing_instructions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "confidence", "existing_id", "source_quote"],
        properties: {
          text: { type: "string", minLength: 1 },
          confidence: { type: "number" },
          existing_id: { type: ["string", "null"] },
          source_quote: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

type StructuredTurnSummary = {
  readonly summary: string;
  readonly standingInstructions: readonly {
    readonly text: string;
    readonly confidence: number;
    readonly existingId?: string;
    readonly sourceQuote: string;
  }[];
};

export class TurnSummaryPipeline {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly nowEpochSeconds: () => number;

  constructor(private readonly deps: {
    readonly repository: TurnSummaryRepositoryPort;
    readonly configService: Pick<TurnSummaryConfigService, "read">;
    readonly summarizer: TurnSummarizer;
    readonly eventHub: Pick<RuntimeSessionEventHub, "publish">;
    readonly sessionBroadcaster?: Pick<
      InMemorySseReplayBroadcaster<SessionStreamEvent>,
      "append"
    >;
    readonly storyFolder?: Pick<SessionStoryFoldService, "foldIfNeeded">;
    readonly instructionCommandSender?: (
      payload: PersistentInstructionsApplyPayload,
    ) => Promise<unknown>;
    readonly logger: TurnSummaryLogger;
    readonly nowEpochSeconds?: () => number;
  }) {
    this.nowEpochSeconds = deps.nowEpochSeconds ?? (() => Date.now() / 1_000);
  }

  accept(events: readonly NodeRegistryEvent[]): void {
    for (const job of collectTurnSummaryCompleteJobs(events)) {
      this.enqueue(job);
    }
  }

  async drain(): Promise<void> {
    while (this.tails.size > 0) {
      await Promise.all(this.tails.values());
    }
  }

  private enqueue(job: TurnSummaryCompleteJob): void {
    const previous = this.tails.get(job.sessionId) ?? Promise.resolve();
    const next = previous
      .then(async () => await this.process(job))
      .catch((error) => {
        if (error instanceof TurnSummaryProviderUnavailableError) return;
        this.deps.logger.warn(
          {
            err: error,
            sessionId: job.sessionId,
            completeEventId: job.completeEventId,
            ...failureMetrics(error),
          },
          "Turn summary skipped",
        );
      })
      .finally(() => {
        if (this.tails.get(job.sessionId) === next) {
          this.tails.delete(job.sessionId);
        }
      });
    this.tails.set(job.sessionId, next);
  }

  private async process(job: TurnSummaryCompleteJob): Promise<void> {
    const config = this.deps.configService.read();
    if (!config.enabled) return;
    const turn = await this.deps.repository.loadTurn(
      job.sessionId,
      job.completeEventId,
    );
    if (turn === null) {
      this.debugSkip(job, "turn_not_reconstructable");
      return;
    }
    if (isCacheKeepaliveTurn(turn)) {
      this.debugSkip(job, "cache_keepalive", {
        turnStartEventId: turn.turnStartEventId,
      });
      return;
    }
    const eligibility = resolveTurnSummaryEligibility({
      metadata: turn.metadata,
      folderId: turn.folderId,
      excludedFolderIds: config.excludedFolderIds,
      startEvidence: turn.startEvidence,
    });
    if (!eligibility.include) {
      this.debugSkip(job, eligibility.reason, {
        turnStartEventId: turn.turnStartEventId,
        finalResponseEventId: turn.finalResponseEventId,
        ...startEvidenceLogFields(turn.startEvidence),
      });
      return;
    }
    if (
      await this.deps.repository.hasSummary(
        job.sessionId,
        turn.turnStartEventId,
        turn.finalResponseEventId,
      )
    ) {
      this.debugSkip(job, "already_summarized", {
        turnStartEventId: turn.turnStartEventId,
        finalResponseEventId: turn.finalResponseEventId,
      });
      return;
    }
    if (!await this.deps.repository.isSessionSummarizable(job.sessionId)) {
      this.debugSkip(job, "session_not_summarizable", {
        phase: "before_summarization",
        turnStartEventId: turn.turnStartEventId,
        finalResponseEventId: turn.finalResponseEventId,
      });
      return;
    }
    const previousSummaries =
      await this.deps.repository.loadPreviousSummaries(
        job.sessionId,
        config.historyLimit,
      );
    const persistentSession = readPersistentEnabled(turn.metadata);
    const extractStandingInstructions =
      persistentSession && turn.speaker?.kind === "user";
    const activeInstructions = persistentSession
      ? readPersistentInstructions(turn.metadata)
        .filter((instruction) => instruction.status === "active")
        .map(({ id, text }) => ({ id, text }))
      : [];
    const summaryInput = {
      userText: turn.userText,
      assistantText: turn.assistantText,
      previousSummaries,
      ...(turn.speaker === undefined ? {} : { speaker: turn.speaker }),
    };
    const summaryOptions = persistentSession
      ? {
        outputSchema: PERSISTENT_INSTRUCTION_OUTPUT_SCHEMA,
        extractStandingInstructions,
        persistentInstructions: activeInstructions,
      }
      : undefined;
    const result = summaryOptions === undefined
      ? await this.deps.summarizer.summarize(summaryInput, config)
      : await this.deps.summarizer.summarize(
        summaryInput,
        config,
        summaryOptions,
      );
    const structured = summaryOptions === undefined
      ? null
      : parseStructuredTurnSummary(result.content);
    const summaryResult = structured === null
      ? result
      : { ...result, content: structured.summary };
    if (!await this.deps.repository.isSessionSummarizable(job.sessionId)) {
      this.debugSkip(job, "session_not_summarizable", {
        phase: "after_summarization",
        turnStartEventId: turn.turnStartEventId,
        finalResponseEventId: turn.finalResponseEventId,
      });
      return;
    }
    const payload = buildTurnSummaryPayload(
      turn.turnStartEventId,
      turn.finalResponseEventId,
      summaryResult,
      this.nowEpochSeconds(),
    );
    const persisted = await this.deps.repository.appendSummary(
      job.sessionId,
      payload,
      summaryDedupeKey(turn.turnStartEventId, turn.finalResponseEventId),
    );
    if (!persisted.inserted) {
      this.debugSkip(job, "already_summarized", {
        phase: "append",
        turnStartEventId: turn.turnStartEventId,
        finalResponseEventId: turn.finalResponseEventId,
      });
      return;
    }
    const gapEvents = await this.deps.repository.loadGapEvents(
      job.sessionId,
      job.completeEventId,
      persisted.eventId,
    );
    for (const data of gapEvents) {
      this.deps.eventHub.publish({ nodeId: job.nodeId, data });
    }
    this.deps.eventHub.publish({
      nodeId: job.nodeId,
      data: {
        type: "event",
        agentSessionId: job.sessionId,
        event: {
          ...payload,
          _event_id: persisted.eventId,
        },
      },
    });
    this.deps.logger.info?.(
      {
        sessionId: job.sessionId,
        model: summaryResult.model,
        latencyMs: summaryResult.latencyMs,
        attempts: summaryResult.attempts,
        ...(summaryResult.spawnDurationMs === undefined
          ? {}
          : { spawnDurationMs: summaryResult.spawnDurationMs }),
        ...(summaryResult.peakConcurrentSpawns === undefined
          ? {}
          : { peakConcurrentSpawns: summaryResult.peakConcurrentSpawns }),
        usage: summaryResult.usage,
      },
      "Turn summary stored",
    );
    if (extractStandingInstructions && structured !== null) {
      await this.storeExtractedInstructions(
        job.sessionId,
        turn,
        persisted.eventId,
        structured,
      );
    }
    await this.deps.storyFolder?.foldIfNeeded(job.sessionId);
  }

  private async storeExtractedInstructions(
    sessionId: string,
    turn: TurnSummaryTurn,
    summaryEventId: number,
    structured: StructuredTurnSummary,
  ): Promise<void> {
    const extracted = structured.standingInstructions.filter(
      (instruction) =>
        instruction.confidence >= 0.7 &&
        instruction.sourceQuote.trim().length > 0 &&
        turn.userText.includes(instruction.sourceQuote),
    );
    if (extracted.length === 0) return;
    if (this.deps.instructionCommandSender === undefined) {
      throw new Error("Persistent instruction command sender is unavailable");
    }

    const turnNumber = await this.deps.repository.countTurnSummariesThrough(
      sessionId,
      summaryEventId,
    );
    const activeById = new Map(
      readPersistentInstructions(turn.metadata)
        .filter((instruction) => instruction.status === "active")
        .map((instruction) => [instruction.id, instruction]),
    );
    const sourceTurns = [`T${turnNumber}`];
    const sourceEventIds = [turn.turnStartEventId];
    const ops = extracted.map((instruction) => {
      const existing = instruction.existingId === undefined
        ? undefined
        : activeById.get(instruction.existingId);
      return existing === undefined
        ? {
          op: "add" as const,
          text: instruction.text,
          source_turns: sourceTurns,
          source_event_ids: sourceEventIds,
        }
        : {
          op: "touch" as const,
          id: existing.id,
          source_turns: sourceTurns,
          source_event_ids: sourceEventIds,
        };
    });
    const payload: PersistentInstructionsApplyPayload = {
      session_id: sessionId,
      origin: "extracted",
      ops,
      ...(turn.inputId === undefined ? {} : { anchor: turn.inputId }),
    };
    await this.deps.instructionCommandSender(payload);
  }

  private debugSkip(
    job: TurnSummaryCompleteJob,
    reason: TurnSummarySkipReason,
    details: Record<string, unknown> = {},
  ): void {
    this.deps.logger.debug?.(
      {
        ...details,
        reason,
        sessionId: job.sessionId,
        completeEventId: job.completeEventId,
      },
      "Turn summary skipped",
    );
  }
}

export function collectTurnSummaryCompleteJobs(
  events: readonly NodeRegistryEvent[],
): TurnSummaryCompleteJob[] {
  const jobs: TurnSummaryCompleteJob[] = [];
  for (const registryEvent of events) {
    if (registryEvent.type !== "node_session_event") continue;
    const envelope = registryEvent.data;
    if (envelope.type !== "event") continue;
    const sessionId = stringValue(
      envelope.agentSessionId ??
        envelope.agent_session_id ??
        envelope.sessionId ??
        envelope.session_id,
    );
    const event = recordValue(envelope.event);
    const completeEventId = positiveInteger(event._event_id);
    if (
      sessionId === null ||
      event.type !== "complete" ||
      completeEventId === null
    ) {
      continue;
    }
    jobs.push({
      nodeId: registryEvent.nodeId,
      sessionId,
      completeEventId,
    });
  }
  return jobs;
}

export function resolveTurnSummaryEligibility(params: {
  readonly metadata: unknown;
  readonly folderId: string | null;
  readonly excludedFolderIds: readonly string[];
  readonly startEvidence: TurnSummaryStartEvidence;
}):
  | {
      readonly include: true;
      readonly reason:
        | "user_input"
        | "intervention"
        | "legacy_evidence_missing"
        | "first_delegated_completion"
        | "delegated_completion_after_new_input";
    }
  | {
      readonly include: false;
      readonly reason:
        | "internal_summary"
        | "agent_origin"
        | "excluded_folder"
        | "system_notification"
        | "delegated_terminal_failure"
        | "delegated_completion_without_new_input";
    } {
  const metadata = params.metadata;
  const entries = Array.isArray(metadata)
    ? metadata.filter(isRecord)
    : isRecord(metadata)
      ? [metadata]
      : [];
  if (
    entries.some(
      (entry) =>
        entry.type === "turn_summary_internal" ||
        entry.turn_summary_internal === true,
    )
  ) {
    return { include: false, reason: "internal_summary" };
  }
  const firstCallerSource = firstCallerInfoSource(metadata);
  if (
    firstCallerSource === "agent" &&
    !readPersistentEnabled(metadata)
  ) {
    return { include: false, reason: "agent_origin" };
  }
  if (
    params.folderId !== null &&
    params.excludedFolderIds.includes(params.folderId)
  ) {
    return { include: false, reason: "excluded_folder" };
  }
  const evidence = params.startEvidence;
  if (evidence.kind === "user_message") {
    return { include: true, reason: "user_input" };
  }
  if (evidence.kind === "intervention_sent") {
    return { include: true, reason: "intervention" };
  }
  if (evidence.kind === "system_notification") {
    return { include: false, reason: "system_notification" };
  }
  if (
    evidence.currentTerminalStatus !== null &&
    evidence.currentTerminalStatus !== "completed"
  ) {
    return { include: false, reason: "delegated_terminal_failure" };
  }
  if (evidence.evidenceState !== "complete") {
    return { include: true, reason: "legacy_evidence_missing" };
  }
  if (evidence.previousCompletedRevision === null) {
    return { include: true, reason: "first_delegated_completion" };
  }
  if (evidence.hasNewExternalInput === true) {
    return {
      include: true,
      reason: "delegated_completion_after_new_input",
    };
  }
  return {
    include: false,
    reason: "delegated_completion_without_new_input",
  };
}

export function isCacheKeepaliveTurn(
  turn: Pick<TurnSummaryTurn, "inputPurpose">,
): boolean {
  return turn.inputPurpose === "cache_keepalive";
}

function parseStructuredTurnSummary(
  content: string,
): StructuredTurnSummary | null {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value) || hasUnknownKeys(value, ["summary", "standing_instructions"])) {
    return null;
  }
  if (
    typeof value.summary !== "string" ||
    !Array.isArray(value.standing_instructions)
  ) {
    return null;
  }
  const standingInstructions: Array<{
    text: string;
    confidence: number;
    existingId?: string;
    sourceQuote: string;
  }> = [];
  for (const rawInstruction of value.standing_instructions) {
    if (
      !isRecord(rawInstruction) ||
      hasUnknownKeys(rawInstruction, [
        "text",
        "confidence",
        "existing_id",
        "source_quote",
      ]) ||
      typeof rawInstruction.text !== "string" ||
      rawInstruction.text.trim().length === 0 ||
      typeof rawInstruction.confidence !== "number" ||
      !Number.isFinite(rawInstruction.confidence) ||
      !Object.hasOwn(rawInstruction, "existing_id") ||
      (rawInstruction.existing_id !== null &&
        typeof rawInstruction.existing_id !== "string")
    ) {
      return null;
    }
    if (
      typeof rawInstruction.source_quote !== "string" ||
      rawInstruction.source_quote.trim().length === 0
    ) {
      continue;
    }
    standingInstructions.push({
      text: rawInstruction.text.trim(),
      confidence: rawInstruction.confidence,
      ...(typeof rawInstruction.existing_id !== "string"
        ? {}
        : { existingId: rawInstruction.existing_id }),
      sourceQuote: rawInstruction.source_quote,
    });
  }
  return { summary: value.summary, standingInstructions };
}

function startEvidenceLogFields(
  evidence: TurnSummaryStartEvidence,
): Record<string, unknown> {
  if (evidence.kind !== "completion_notification") {
    return {
      childSessionId: null,
      currentRevision: null,
      previousCompletedRevision: null,
      evidenceState: evidence.evidenceState,
    };
  }
  return {
    childSessionId: evidence.childSessionId,
    currentRevision: evidence.currentRevision,
    previousCompletedRevision: evidence.previousCompletedRevision,
    evidenceState: evidence.evidenceState,
  };
}

function buildTurnSummaryPayload(
  turnStartEventId: number,
  finalResponseEventId: number,
  result: TurnSummaryResult,
  timestamp: number,
): Record<string, unknown> {
  return {
    type: "turn_summary",
    content: result.content,
    turn_start_event_id: turnStartEventId,
    final_response_event_id: finalResponseEventId,
    parent_event_id: finalResponseEventId,
    model: result.model,
    latency_ms: result.latencyMs,
    attempts: result.attempts,
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    timestamp,
  };
}

function firstCallerInfoSource(metadata: unknown): string | null {
  if (Array.isArray(metadata)) {
    for (const entry of metadata) {
      if (!isRecord(entry) || entry.type !== "caller_info") continue;
      const source = stringValue(recordValue(entry.value).source);
      if (source !== null) return source;
    }
    return null;
  }
  const record = recordValue(metadata);
  const callerInfo = recordValue(record.caller_info ?? record.callerInfo);
  return stringValue(callerInfo.source);
}

function failureMetrics(
  error: unknown,
): {
  readonly attempts?: number;
  readonly latencyMs?: number;
  readonly spawnDurationMs?: number;
  readonly peakConcurrentSpawns?: number;
} {
  const record = recordValue(error);
  return {
    ...(typeof record.attempts === "number"
      ? { attempts: record.attempts }
      : {}),
    ...(typeof record.latencyMs === "number"
      ? { latencyMs: record.latencyMs }
      : {}),
    ...(typeof record.spawnDurationMs === "number"
      ? { spawnDurationMs: record.spawnDurationMs }
      : {}),
    ...(typeof record.peakConcurrentSpawns === "number"
      ? { peakConcurrentSpawns: record.peakConcurrentSpawns }
      : {}),
  };
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value > 0
    ? value
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).some((key) => !allowed.includes(key));
}
