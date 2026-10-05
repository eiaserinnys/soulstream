import type { Logger } from "pino";
import { isPersistentJevCandidatesDebugEvent } from "@soulstream/wire-schema/persistent-jev-candidates";
import type { PersistentJevCandidatesDebugEvent } from "@soulstream/wire-schema/persistent-jev-candidates";

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
      let validatedEvent: PersistentJevCandidatesDebugEvent | null = null;
      if (observation !== null) {
        const candidateEvent = {
          type: "debug" as const,
          kind: "persistent_jev_candidates" as const,
          observation,
        };
        if (!isPersistentJevCandidatesDebugEvent(candidateEvent)) {
          logFailure(deps.logger, sessionId, "response");
          return;
        }
        if (candidateEvent.observation.input_id !== inputId) {
          logFailure(deps.logger, sessionId, "response");
          return;
        }
        validatedEvent = candidateEvent;
      }
      if (Date.now() >= deadlineAt) {
        logFailure(deps.logger, sessionId, "timeout");
        return;
      }
      if (validatedEvent === null) return;

      const event = {
        ...validatedEvent,
        timestamp: Date.now() / 1_000,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimeout(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (isRecord(error) &&
    (error.name === "TimeoutError" || error.name === "AbortError"));
}

function logFailure(logger: Pick<Logger, "warn">, sessionId: string, failureKind: string): void {
  logger.warn({ sessionId, failureKind }, "persistent Jev candidate observation skipped");
}
