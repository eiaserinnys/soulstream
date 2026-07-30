import type { NodeRegistryEvent } from "../node/registry.js";
import type { RuntimeSessionEventHub } from "../runtime/session_event_hub.js";
import type {
  TurnSummaryConfig,
  TurnSummaryConfigService,
  TurnSummaryLogger,
} from "./turn_summary_config.js";
import {
  summaryDedupeKey,
  type TurnSummaryRepositoryPort,
} from "./turn_summary_repository.js";
import type {
  TurnSummarizer,
  TurnSummaryResult,
} from "./turn_summarizer.js";
import { TurnSummaryProviderUnavailableError } from
  "./turn_summary_provider_router.js";

export interface TurnSummaryCompleteJob {
  readonly nodeId: string;
  readonly sessionId: string;
  readonly completeEventId: number;
}

export class TurnSummaryPipeline {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly nowEpochSeconds: () => number;

  constructor(private readonly deps: {
    readonly repository: TurnSummaryRepositoryPort;
    readonly configService: Pick<TurnSummaryConfigService, "read">;
    readonly summarizer: TurnSummarizer;
    readonly eventHub: Pick<RuntimeSessionEventHub, "publish">;
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
            error,
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
    if (turn === null) return;
    if (!resolveTurnSummaryEligibility({
      metadata: turn.metadata,
      folderId: turn.folderId,
      excludedFolderIds: config.excludedFolderIds,
    }).include) {
      return;
    }
    if (
      await this.deps.repository.hasSummary(
        job.sessionId,
        turn.turnStartEventId,
        turn.finalResponseEventId,
      )
    ) {
      return;
    }
    if (!await this.deps.repository.isSessionSummarizable(job.sessionId)) {
      return;
    }
    const previousSummaries =
      await this.deps.repository.loadPreviousSummaries(
        job.sessionId,
        config.historyLimit,
      );
    const result = await this.deps.summarizer.summarize({
      userText: turn.userText,
      assistantText: turn.assistantText,
      previousSummaries,
    }, config);
    if (!await this.deps.repository.isSessionSummarizable(job.sessionId)) {
      return;
    }
    const payload = buildTurnSummaryPayload(
      turn.turnStartEventId,
      turn.finalResponseEventId,
      result,
      this.nowEpochSeconds(),
    );
    const persisted = await this.deps.repository.appendSummary(
      job.sessionId,
      payload,
      summaryDedupeKey(turn.turnStartEventId, turn.finalResponseEventId),
    );
    if (!persisted.inserted) return;
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
        model: result.model,
        latencyMs: result.latencyMs,
        attempts: result.attempts,
        ...(result.spawnDurationMs === undefined
          ? {}
          : { spawnDurationMs: result.spawnDurationMs }),
        ...(result.peakConcurrentSpawns === undefined
          ? {}
          : { peakConcurrentSpawns: result.peakConcurrentSpawns }),
        usage: result.usage,
      },
      "Turn summary stored",
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
}):
  | { readonly include: true }
  | {
      readonly include: false;
      readonly reason: "internal_summary" | "agent_origin" | "excluded_folder";
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
  if (firstCallerSource === "agent") {
    return { include: false, reason: "agent_origin" };
  }
  if (
    params.folderId !== null &&
    params.excludedFolderIds.includes(params.folderId)
  ) {
    return { include: false, reason: "excluded_folder" };
  }
  return { include: true };
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
