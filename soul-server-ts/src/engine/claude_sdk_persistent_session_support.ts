import { createHash } from "node:crypto";

import type {
  Query as ClaudeSdkQuery,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { ClaudeClientEvent } from "./claude_event_mapper.js";
import type { EventQueue } from "./claude_sdk_event_queue.js";
import { messageContent } from "./claude_sdk_event_mapper_helpers.js";
import { asRecord, asString } from "./claude_sdk_helpers.js";
import type { ClaudeSdkEventMapper } from "./claude_sdk_event_mapper.js";
import type { RateLimitTerminationState } from
  "./claude_sdk_rate_limit_stop_failure.js";
import type {
  ClaudeForegroundPhase,
  ClaudeStaleInterruptReceiptObservation,
  ClaudeTurnOwner,
} from "./claude_session_runtime.js";
import type { TurnOrigin } from "./protocol.js";

export type ClaudeDetachedEventSink = (event: ClaudeClientEvent) => Promise<void>;
export type ClaudeRuntimeEventSink = (
  event: ClaudeClientEvent,
) => Promise<boolean | void>;

export interface ClaudeSdkPersistentSessionConfig {
  createQuery(input: AsyncIterable<SDKUserMessage>): ClaudeSdkQuery;
  eventMapper: ClaudeSdkEventMapper;
  hookOutput: EventQueue<ClaudeClientEvent>;
  detachedEventSink: ClaudeDetachedEventSink;
  runtimeEventSink?: ClaudeRuntimeEventSink;
  logger: Logger;
  postResultDrainMs: number;
  turnInactivityTimeoutMs: number;
  runtimeFollowupNoOutputTimeoutMs: number;
  onClosed?(): void;
}

export type ActiveForeground = {
  uuid: string;
  /** Owner captured immediately before a native intervention interrupts it. */
  interruptedOwnerUuid?: string;
  interventionInterrupt?: InterventionInterruptObservation;
  output: EventQueue<ClaudeClientEvent>;
  interruptResultTimer: ReturnType<typeof setTimeout> | null;
  timedOut: boolean;
  origin: { kind: string; id: string };
  rateLimitTerminationState: RateLimitTerminationState;
};

export type InterventionInterruptObservation = {
  promise: Promise<boolean>;
  resolve(observed: boolean): void;
  observed: boolean;
  settled: boolean;
};

export class ClaudeExactResultCache {
  private readonly byInputUuid = new Map<string, ClaudeClientEvent>();

  get(uuid: string): ClaudeClientEvent | undefined {
    return this.byInputUuid.get(uuid);
  }

  clear(): void {
    this.byInputUuid.clear();
  }

  mapAndRecord(
    message: Record<string, unknown>,
    mapper: Pick<ClaudeSdkEventMapper, "mapResultMessage">,
    inputs: { hasInput(uuid: string): boolean },
  ): ClaudeClientEvent[] {
    const events = mapper.mapResultMessage(message);
    const inputUuid = asString(message.user_message_uuid);
    const exactResult = events.find((event) => event.type === "result");
    if (inputUuid && exactResult && inputs.hasInput(inputUuid)) {
      this.byInputUuid.set(inputUuid, exactResult);
    }
    return events;
  }
}

export function createInterventionInterruptObservation(): InterventionInterruptObservation {
  let resolvePromise!: (observed: boolean) => void;
  const observation: InterventionInterruptObservation = {
    promise: new Promise<boolean>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve: (observed) => {
      resolvePromise(observed);
    },
    observed: false,
    settled: false,
  };
  return observation;
}

export async function waitForInterventionEffect(
  observation: InterventionInterruptObservation,
  interrupt: () => Promise<unknown>,
  logger: Pick<Logger, "info" | "warn">,
  uuid: string,
): Promise<boolean> {
  let rejectControlFailure!: (error: unknown) => void;
  const controlFailure = new Promise<never>((_resolve, reject) => {
    rejectControlFailure = reject;
  });
  void interrupt().then(
    () => {
      if (observation.observed) {
        logger.info(
          { uuid },
          "Claude interrupt receipt arrived after its effect was observed",
        );
      }
    },
    (error: unknown) => {
      if (observation.settled) {
        logger.warn(
          { err: error, uuid },
          observation.observed
            ? "Claude interrupt failed after its effect was observed"
            : "Claude interrupt failed after the intervention had already settled",
        );
        return;
      }
      rejectControlFailure(error);
    },
  );
  return await Promise.race([observation.promise, controlFailure]);
}

export function makeStaleInterruptReceiptLogger(
  logger: Pick<Logger, "warn">,
): (observation: ClaudeStaleInterruptReceiptObservation) => void {
  return (observation) => {
    logger.warn(
      observation,
      "Ignoring Claude interrupt receipt from a finished foreground turn",
    );
  };
}

export function isPostInterruptContinuation(event: ClaudeClientEvent): boolean {
  return event.type === "progress"
    || event.type === "text"
    || event.type === "thinking"
    || event.type === "tool_start"
    || event.type === "input_request"
    || event.type === "subagent_start";
}

export function shouldFencePostInterruptContinuation(
  active: ActiveForeground | null,
  event: ClaudeClientEvent,
): active is ActiveForeground {
  return Boolean(active?.interventionInterrupt) && isPostInterruptContinuation(event);
}

export function isExpectedInterruptTerminalEvent(
  event: ClaudeClientEvent,
  expectedDiagnostic: boolean,
): boolean {
  return isExpectedInterruptDiagnostic(event)
    || (expectedDiagnostic && event.type === "result" && !event.success);
}

export function settleInterventionInterrupt(
  active: ActiveForeground | null,
  observed: boolean,
): void {
  const observation = active?.interventionInterrupt;
  if (!observation || observation.settled) return;
  observation.observed = observed;
  observation.settled = true;
  observation.resolve(observed);
}

export function describeResultProvenance(
  message: Record<string, unknown>,
): Record<string, unknown> {
  return {
    resultUuid: asString(message.uuid),
    subtype: asString(message.subtype),
    isError: message.is_error === true,
    terminalReason: asString(message.terminal_reason) ?? null,
    originKind: asString(asRecord(message.origin)?.kind) ?? null,
    numTurns: message.num_turns ?? null,
  };
}

export function provableTurnResultOwner(
  phase: ClaudeForegroundPhase,
  active: ActiveForeground | null,
  message: Record<string, unknown>,
  logger: Logger,
): string | null {
  const explicitOwnerUuid = asString(message.user_message_uuid);
  if (explicitOwnerUuid) return explicitOwnerUuid;
  // Bare Results also terminate SDK-owned notification turns. Only the abort
  // Result of our sole interrupting foreground can inherit local ownership.
  if (phase !== "interrupting" || !active) return null;
  if (asString(asRecord(message.origin)?.kind) === "task-notification") return null;
  const ownerUuid = active.interruptedOwnerUuid ?? active.uuid;
  logger.info(
    {
      activeForegroundUuid: active.uuid,
      interruptedOwnerUuid: ownerUuid,
      resultUuid: asString(message.uuid),
    },
    "Correlating Claude Result without user_message_uuid to the interrupted turn",
  );
  return ownerUuid;
}

export function isExpectedInterruptDiagnostic(event: ClaudeClientEvent): boolean {
  return event.type === "error"
    && event.fatal === false
    && event.errorCode === "error_during_execution";
}

export function isTurnStartingUserInput(message: Record<string, unknown>): boolean {
  if (message.isSynthetic === true) return false;
  const content = messageContent(message);
  return content.length === 0
    || content.some((block) => asString(asRecord(block)?.type) !== "tool_result");
}

export function hashSdkUserMessage(message: SDKUserMessage): string {
  return createHash("sha256").update(canonicalJson({
    role: message.message.role,
    content: message.message.content,
  })).digest("hex");
}

export function normalizePersistentTurnOwner(
  turnOrigin: TurnOrigin | undefined,
  uuid: string,
): ClaudeTurnOwner {
  return {
    kind: turnOrigin?.kind ?? "initial_prompt",
    id: turnOrigin?.id ?? uuid,
  };
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(",")}}`;
}

export function turnInactivityError(timeoutMs: number): ClaudeClientEvent {
  return {
    type: "error",
    fatal: true,
    errorCode: "claude_persistent_turn_timeout",
    message: `Claude foreground turn was inactive for ${timeoutMs}ms and was interrupted.`,
  };
}
