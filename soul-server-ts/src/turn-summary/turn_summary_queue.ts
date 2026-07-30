import type { Logger } from "pino";

import type { EventPersistence } from "../db/event_persistence.js";
import type { SessionDB } from "../db/session_db.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import type { SessionBroadcaster } from "../upstream/session_broadcaster.js";

import type {
  TurnSummaryConfig,
  TurnSummaryConfigService,
} from "./turn_summary_config.js";
import type { TurnSummarizer } from "./turn_summarizer.js";
import { isTurnSummaryProviderUnavailableError } from
  "./turn_summary_provider_router.js";

export interface TurnSummaryJob {
  sessionId: string;
  userText: string;
  assistantText: string;
  turnStartEventId: number;
  finalResponseEventId: number;
}

export interface TurnSummaryQueuePort {
  enqueue(job: TurnSummaryJob): void;
}

export interface TurnSummaryQueueDeps {
  db: Pick<SessionDB, "getSession" | "readLatestEvents">;
  configService: Pick<TurnSummaryConfigService, "read">;
  summarizer: TurnSummarizer;
  persistence: Pick<EventPersistence, "persistEventWithResult">;
  broadcaster: Pick<SessionBroadcaster, "emitEventEnvelope">;
  logger: Logger;
  nowEpochSeconds?: () => number;
}

export class TurnSummaryQueue implements TurnSummaryQueuePort {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly nowEpochSeconds: () => number;

  constructor(private readonly deps: TurnSummaryQueueDeps) {
    this.nowEpochSeconds = deps.nowEpochSeconds ?? (() => Date.now() / 1000);
  }

  enqueue(job: TurnSummaryJob): void {
    const previous = this.tails.get(job.sessionId) ?? Promise.resolve();
    const next = previous
      .then(() => this.process(job))
      .catch((err) => {
        if (isTurnSummaryProviderUnavailableError(err)) return;
        this.deps.logger.warn(
          {
            err,
            sessionId: job.sessionId,
            ...extractFailureMetrics(err),
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

  async drain(): Promise<void> {
    while (this.tails.size > 0) {
      await Promise.all(this.tails.values());
    }
  }

  private async process(job: TurnSummaryJob): Promise<void> {
    const config = this.deps.configService.read();
    const session = await this.deps.db.getSession(job.sessionId);
    if (!session) return;
    const eligibility = resolveTurnSummaryEligibility({
      metadata: session.metadata,
      folderId: session.folder_id,
      excludedFolderIds: config.excludedFolderIds,
    });
    if (!eligibility.include) return;

    const history = await this.deps.db.readLatestEvents(
      job.sessionId,
      config.historyLimit,
      ["turn_summary"],
    );
    const previousSummaries = history
      .map((row) => row.payload.content)
      .filter((content): content is string => typeof content === "string");
    const result = await this.deps.summarizer.summarize({
      userText: job.userText,
      assistantText: job.assistantText,
      previousSummaries,
    }, config);
    const event = buildTurnSummaryEvent(job, result, this.nowEpochSeconds());
    const persisted = await this.deps.persistence.persistEventWithResult(
      job.sessionId,
      event,
    );
    delete (event as Record<string, unknown>)._dedupe_key;
    if (!persisted.inserted) return;
    (event as Record<string, unknown>)._event_id = persisted.eventId;
    await this.deps.broadcaster.emitEventEnvelope(job.sessionId, event);
    this.deps.logger.info(
      {
        sessionId: job.sessionId,
        model: result.model,
        latencyMs: result.latencyMs,
        attempts: result.attempts,
        usage: result.usage,
      },
      "Turn summary stored",
    );
  }
}

export function resolveTurnSummaryEligibility(params: {
  metadata: unknown;
  folderId: string | null;
  excludedFolderIds: string[];
}):
  | { include: true }
  | {
      include: false;
      reason: "internal_summary" | "agent_origin" | "excluded_folder";
    } {
  const entries = Array.isArray(params.metadata)
    ? params.metadata.filter(isRecord)
    : [];
  if (entries.some((entry) => entry.type === "turn_summary_internal")) {
    return { include: false, reason: "internal_summary" };
  }
  const callerEntry = entries.find(
    (entry) => entry.type === "caller_info" && isRecord(entry.value) &&
      typeof entry.value.source === "string",
  );
  if (
    callerEntry &&
    isRecord(callerEntry.value) &&
    callerEntry.value.source === "agent"
  ) {
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

function buildTurnSummaryEvent(
  job: TurnSummaryJob,
  result: Awaited<ReturnType<TurnSummarizer["summarize"]>>,
  timestamp: number,
): SSEEventPayload {
  return {
    type: "turn_summary",
    content: result.content,
    turn_start_event_id: job.turnStartEventId,
    final_response_event_id: job.finalResponseEventId,
    parent_event_id: job.finalResponseEventId,
    model: result.model,
    latency_ms: result.latencyMs,
    attempts: result.attempts,
    ...(result.usage ? { usage: result.usage } : {}),
    timestamp,
    _dedupe_key:
      `turn_summary:${job.turnStartEventId}:${job.finalResponseEventId}`,
  } as unknown as SSEEventPayload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractFailureMetrics(
  error: unknown,
): { attempts?: number; latencyMs?: number } {
  if (!isRecord(error)) return {};
  return {
    ...(typeof error.attempts === "number"
      ? { attempts: error.attempts }
      : {}),
    ...(typeof error.latencyMs === "number"
      ? { latencyMs: error.latencyMs }
      : {}),
  };
}
