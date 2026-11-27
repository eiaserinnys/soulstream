import type { NodeRegistryEvent } from "../node/registry.js";
import {
  readPersistentInstructions,
  type PersistentInstructionsApplyPayload,
} from "@soulstream/wire-schema/persistent-session-instructions";
import { readPersistentEnabled } from
  "@soulstream/wire-schema/persistent-session-settings";
import type { RuntimeSessionEventHub } from "../runtime/session_event_hub.js";
import { asRecord, isRecord } from "@soulstream/wire-schema/json-record";
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
import type {
  PersistentInstructionCandidate,
  PersistentInstructionExtractor,
} from "./persistent_instruction_extractor.js";
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

export type TurnSummaryJobOutcome =
  | { readonly status: "stored" }
  | {
      readonly status: "skipped";
      readonly reason:
        | TurnSummarySkipReason
        | "disabled"
        | "provider_unavailable";
    }
  | { readonly status: "failed"; readonly error: unknown };

export class TurnSummaryPipeline {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly nowEpochSeconds: () => number;

  constructor(private readonly deps: {
    readonly repository: TurnSummaryRepositoryPort;
    readonly configService: Pick<TurnSummaryConfigService, "read">;
    readonly summarizer: TurnSummarizer;
    readonly persistentInstructionExtractor?: PersistentInstructionExtractor;
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
      void this.enqueue(job);
    }
  }

  async drain(): Promise<void> {
    while (this.tails.size > 0) {
      await Promise.all(this.tails.values());
    }
  }

  enqueue(job: TurnSummaryCompleteJob): Promise<TurnSummaryJobOutcome> {
    const previous = this.tails.get(job.sessionId) ?? Promise.resolve();
    const outcome = previous
      .then(async () => await this.process(job))
      .catch((error): TurnSummaryJobOutcome => {
        if (error instanceof TurnSummaryProviderUnavailableError) {
          return { status: "skipped", reason: "provider_unavailable" };
        }
        this.deps.logger.warn(
          {
            err: error,
            sessionId: job.sessionId,
            completeEventId: job.completeEventId,
            ...failureMetrics(error),
          },
          "Turn summary skipped",
        );
        return { status: "failed", error };
      });
    const tail = outcome.then(() => undefined);
    this.tails.set(job.sessionId, tail);
    void tail.finally(() => {
      if (this.tails.get(job.sessionId) === tail) {
        this.tails.delete(job.sessionId);
      }
    });
    return outcome;
  }

  private async process(
    job: TurnSummaryCompleteJob,
  ): Promise<TurnSummaryJobOutcome> {
    const config = this.deps.configService.read();
    if (!config.turnEnabled) return { status: "skipped", reason: "disabled" };
    const turn = await this.deps.repository.loadTurn(
      job.sessionId,
      job.completeEventId,
    );
    if (turn === null) {
      return this.debugSkip(job, "turn_not_reconstructable");
    }
    if (isCacheKeepaliveTurn(turn)) {
      return this.debugSkip(job, "cache_keepalive", {
        turnStartEventId: turn.turnStartEventId,
      });
    }
    const eligibility = resolveTurnSummaryEligibility({
      metadata: turn.metadata,
      folderId: turn.folderId,
      excludedFolderIds: config.excludedFolderIds,
      startEvidence: turn.startEvidence,
    });
    if (!eligibility.include) {
      return this.debugSkip(job, eligibility.reason, {
        turnStartEventId: turn.turnStartEventId,
        finalResponseEventId: turn.finalResponseEventId,
        ...startEvidenceLogFields(turn.startEvidence),
      });
    }
    if (
      await this.deps.repository.hasSummary(
        job.sessionId,
        turn.turnStartEventId,
        turn.finalResponseEventId,
      )
    ) {
      return this.debugSkip(job, "already_summarized", {
        turnStartEventId: turn.turnStartEventId,
        finalResponseEventId: turn.finalResponseEventId,
      });
    }
    if (!await this.deps.repository.isSessionSummarizable(job.sessionId)) {
      return this.debugSkip(job, "session_not_summarizable", {
        phase: "before_summarization",
        turnStartEventId: turn.turnStartEventId,
        finalResponseEventId: turn.finalResponseEventId,
      });
    }
    const previousSummaries =
      await this.deps.repository.loadPreviousSummaries(
        job.sessionId,
        config.historyLimit,
      );
    const persistentSession = readPersistentEnabled(turn.metadata);
    const shouldExtractInstructions =
      persistentSession && turn.speaker?.kind === "user";
    const summaryInput = {
      userText: turn.userText,
      assistantText: turn.assistantText,
      previousSummaries,
      ...(turn.speaker === undefined ? {} : { speaker: turn.speaker }),
    };
    const summaryResult = await this.deps.summarizer.summarize(
      summaryInput,
      config,
    );
    if (!await this.deps.repository.isSessionSummarizable(job.sessionId)) {
      return this.debugSkip(job, "session_not_summarizable", {
        phase: "after_summarization",
        turnStartEventId: turn.turnStartEventId,
        finalResponseEventId: turn.finalResponseEventId,
      });
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
      return this.debugSkip(job, "already_summarized", {
        phase: "append",
        turnStartEventId: turn.turnStartEventId,
        finalResponseEventId: turn.finalResponseEventId,
      });
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
    await this.deps.storyFolder?.foldIfNeeded(job.sessionId);
    if (shouldExtractInstructions) {
      await this.extractPersistentInstructions(
        job.sessionId,
        turn,
        persisted.eventId,
        config,
      );
    }
    return { status: "stored" };
  }

  private async extractPersistentInstructions(
    sessionId: string,
    turn: TurnSummaryTurn,
    summaryEventId: number,
    config: TurnSummaryConfig,
  ): Promise<void> {
    const extractor = this.deps.persistentInstructionExtractor;
    if (extractor === undefined) {
      this.deps.logger.warn(
        {
          sessionId,
          stage: "extractor",
          reason: "dependency_unavailable",
        },
        "Persistent instruction extraction skipped",
      );
      return;
    }

    let candidates: readonly PersistentInstructionCandidate[];
    try {
      const activeInstructions = readPersistentInstructions(turn.metadata)
        .filter((instruction) => instruction.status === "active")
        .map(({ id, text }) => ({ id, text }));
      candidates = await extractor.extract({
        userText: turn.userText,
        activeInstructions,
      }, config);
    } catch {
      this.deps.logger.warn(
        {
          sessionId,
          stage: "extractor",
          reason: "failed",
        },
        "Persistent instruction extraction skipped",
      );
      return;
    }

    try {
      await this.storeExtractedInstructions(
        sessionId,
        turn,
        summaryEventId,
        candidates,
      );
    } catch {
      this.deps.logger.warn(
        {
          sessionId,
          stage: "instruction_store",
          reason: "failed",
        },
        "Persistent instruction extraction skipped",
      );
    }
  }

  private async storeExtractedInstructions(
    sessionId: string,
    turn: TurnSummaryTurn,
    summaryEventId: number,
    candidates: readonly PersistentInstructionCandidate[],
  ): Promise<void> {
    const extracted = candidates.filter(
      (instruction) =>
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
  ): TurnSummaryJobOutcome {
    this.deps.logger.debug?.(
      {
        ...details,
        reason,
        sessionId: job.sessionId,
        completeEventId: job.completeEventId,
      },
      "Turn summary skipped",
    );
    return { status: "skipped", reason };
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
    const event = asRecord(envelope.event) ?? {};
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
      const source = stringValue(asRecord(entry.value)?.source);
      if (source !== null) return source;
    }
    return null;
  }
  const record = asRecord(metadata) ?? {};
  const callerInfo = asRecord(record.caller_info ?? record.callerInfo) ?? {};
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
  const record = asRecord(error) ?? {};
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
