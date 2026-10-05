import type { Logger } from "pino";

import type { EventPersistence } from "../db/event_persistence.js";
import type { SSEEventPayload } from "../engine/protocol.js";
import { fetchOrchResponse } from "../control_plane/persistence_host_transport.js";
import type { OrchProxyConfig } from "../mcp/runtime.js";

export interface PersistentResumeObservationInput {
  sessionId: string;
  inputId: string;
  request: string;
}

export type PersistentResumeObserver = (
  input: PersistentResumeObservationInput,
) => Promise<void>;

interface PersistentJevObserverDeps {
  orch: Pick<OrchProxyConfig, "baseUrl" | "headers">;
  persistence: Pick<EventPersistence, "enqueueEvent">;
  logger: Pick<Logger, "warn">;
  fetchImpl?: typeof fetch;
}

const OBSERVATION_WINDOW_MS = 3_000;
const OBSERVATION_PATH = "/api/persistent-context/host/evaluate";

export function createPersistentJevObserver(
  deps: PersistentJevObserverDeps,
): PersistentResumeObserver {
  return async ({ sessionId, inputId, request }) => {
    const startedAt = Date.now();
    const deadlineAt = startedAt + OBSERVATION_WINDOW_MS;
    let timeoutSignal: AbortSignal | undefined;

    try {
      const budgetMs = Math.floor(deadlineAt - Date.now());
      if (budgetMs <= 0) {
        logFailure(deps.logger, sessionId, "timeout");
        return;
      }
      timeoutSignal = AbortSignal.timeout(budgetMs);

      let response: Response;
      try {
        response = await fetchOrchResponse(
          deps.orch,
          "POST",
          OBSERVATION_PATH,
          { args: { session_id: sessionId, input_id: inputId, request, budget_ms: budgetMs } },
          { timeoutMs: budgetMs, signal: timeoutSignal, fetchImpl: deps.fetchImpl },
        );
      } catch (error) {
        logFailure(deps.logger, sessionId, isTimeout(error, timeoutSignal) ? "timeout" : "network");
        return;
      }

      if (!response.ok) {
        logFailure(deps.logger, sessionId, "http");
        return;
      }

      let envelope: unknown;
      try {
        envelope = await response.json();
      } catch {
        logFailure(deps.logger, sessionId, "response");
        return;
      }

      if (!isRecord(envelope) || !("observation" in envelope)) {
        logFailure(deps.logger, sessionId, "response");
        return;
      }
      const observation = envelope.observation;
      if (observation !== null && !isPersistentJevObservation(observation, inputId)) {
        logFailure(deps.logger, sessionId, "response");
        return;
      }
      if (Date.now() >= deadlineAt) {
        logFailure(deps.logger, sessionId, "timeout");
        return;
      }
      if (observation === null) return;

      const event = {
        type: "debug",
        kind: "persistent_jev_candidates",
        timestamp: Date.now() / 1_000,
        observation,
      } as unknown as SSEEventPayload;
      try {
        await deps.persistence.enqueueEvent(sessionId, event);
      } catch {
        logFailure(deps.logger, sessionId, "record");
      }
    } catch (error) {
      logFailure(deps.logger, sessionId, isTimeout(error, timeoutSignal) ? "timeout" : "observer");
    }
  };
}

/** Temporary S2 boundary guard. S1 replaces this single function with the shared wire guard. */
function isPersistentJevObservation(
  value: unknown,
  inputId: string,
): value is Record<string, unknown> {
  if (!isRecord(value) || value.input_id !== inputId || !Array.isArray(value.selected)) {
    return false;
  }
  if (!isRecord(value.candidate_counts) || !isNonNegativeInteger(value.candidate_counts.turn_summaries) ||
    !isNonNegativeInteger(value.candidate_counts.cards) ||
    !isNonNegativeInteger(value.candidate_counts.search_sessions) ||
    !isNonNegativeInteger(value.candidate_counts.recent_completed_sessions) ||
    typeof value.model !== "string" || !isNonNegativeNumber(value.latency_ms)) {
    return false;
  }
  return value.selected.every(isSelectedCandidate);
}

function isSelectedCandidate(value: unknown): boolean {
  if (!isRecord(value) || typeof value.label !== "string" || typeof value.line !== "string" ||
    (value.score !== 2 && value.score !== 3)) {
    return false;
  }
  if (value.kind === "turn_summary") {
    return typeof value.session_id === "string" && isNonNegativeInteger(value.summary_event_id) &&
      isNonNegativeInteger(value.turn_number);
  }
  if (value.kind === "card") {
    return typeof value.card_id === "string" &&
      (value.card_number === undefined || isNonNegativeInteger(value.card_number));
  }
  if (value.kind === "session") {
    return typeof value.session_id === "string" &&
      (value.sources === undefined || (Array.isArray(value.sources) &&
        value.sources.every((source) => source === "search" || source === "recent_completed")));
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isTimeout(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (isRecord(error) &&
    (error.name === "TimeoutError" || error.name === "AbortError"));
}

function logFailure(logger: Pick<Logger, "warn">, sessionId: string, failureKind: string): void {
  logger.warn({ sessionId, failureKind }, "persistent Jev candidate observation skipped");
}
