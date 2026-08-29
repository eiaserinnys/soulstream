import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { ClaudeClientEvent } from "./claude_event_mapper.js";
import { ClaudeSdkEventMapper } from "./claude_sdk_event_mapper.js";
import { isEdeDiagnosticErrorText } from "./claude_sdk_diagnostics.js";
import {
  errorMessage,
  asRecord,
} from "./claude_sdk_helpers.js";
import {
  ClaudeRuntimeState,
  isFatalClientError,
  isRuntimeClientEvent,
  isRuntimeSystemMessage,
} from "./claude_sdk_runtime_state.js";

export const MAX_COMPACT_RETRIES = 3;

const DRAIN_TIMEOUT = Symbol("post_result_drain_timeout");

type ClaudeResultEvent = Extract<ClaudeClientEvent, { type: "result" }>;
export type PostResultContinuationKind = "compact_boundary" | "tool_use";

export type DrainAfterResultOutcome =
  | { action: "finish"; events: ClaudeClientEvent[] }
  | {
      action: "continue";
      reason: PostResultContinuationKind;
      events: ClaudeClientEvent[];
    };

export class ClaudePostResultDrain {
  private readonly logger: Logger;
  private readonly postResultDrainMs: number;
  private readonly runtimeDrainMaxMs: number;
  private readonly eventMapper: ClaudeSdkEventMapper;
  private readonly runtimeState: ClaudeRuntimeState;

  constructor(params: {
    logger: Logger;
    postResultDrainMs: number;
    runtimeDrainMaxMs: number;
    eventMapper: ClaudeSdkEventMapper;
    runtimeState: ClaudeRuntimeState;
  }) {
    this.logger = params.logger;
    this.postResultDrainMs = params.postResultDrainMs;
    this.runtimeDrainMaxMs = params.runtimeDrainMaxMs;
    this.eventMapper = params.eventMapper;
    this.runtimeState = params.runtimeState;
  }

  postResultContinuations(
    resultEvent: ClaudeResultEvent,
    compactRetryCount: number,
  ): Set<PostResultContinuationKind> {
    const continuations = new Set<PostResultContinuationKind>();
    if (!resultEvent.success) return continuations;

    if (resultEvent.stopReason === "tool_use") {
      continuations.add("tool_use");
    }
    if (resultEvent.output.length === 0 && compactRetryCount < MAX_COMPACT_RETRIES) {
      continuations.add("compact_boundary");
    }
    return continuations;
  }

  /**
   * Result 이후 SDK가 보낼 수 있는 trailing/continuation/runtime 메시지를 drain한다.
   *
   * Python `receive_loop._drain_after_result` 정본은 prompt_suggestion만 처리한다.
   * TS SDK에서는 같은 위치에 compact_boundary와 tool_use 재개 메시지도 올 수 있으므로,
   * result의 SDK 신호로 허용된 continuation만 통과시키고 나머지는 terminal drain으로 좁힌다.
   *
   * runtime task/session이 pending이면 SDK `session_state_changed.idle` 또는 runtime task terminal
   * 상태까지 기다린다. 단, `runtimeDrainMaxMs`를 넘기면 query를 닫아 무한 대기를 차단한다.
   */
  async drainAfterResult(
    queryIter: AsyncIterator<SDKMessage>,
    continuations: ReadonlySet<PostResultContinuationKind>,
  ): Promise<DrainAfterResultOutcome> {
    const startedAt = Date.now();
    const events: ClaudeClientEvent[] = [];

    for (;;) {
      const pendingRuntime = this.runtimeState.hasPendingWork();
      const waitMs = pendingRuntime
        ? Math.max(0, this.runtimeDrainMaxMs - (Date.now() - startedAt))
        : this.postResultDrainMs;

      if (waitMs <= 0) {
        events.push(...this.runtimeState.makeTimeoutEvents(this.runtimeDrainMaxMs));
        return { action: "finish", events };
      }

      let settled: IteratorResult<SDKMessage> | typeof DRAIN_TIMEOUT;
      try {
        settled = await this.nextWithDrainTimeout(queryIter, waitMs);
      } catch (err) {
        events.push(this.makeDrainErrorEvent(err));
        return { action: "finish", events };
      }
      if (settled === DRAIN_TIMEOUT) {
        if (pendingRuntime) {
          events.push(...this.runtimeState.makeTimeoutEvents(this.runtimeDrainMaxMs));
        } else {
          this.logger.debug?.({ ms: this.postResultDrainMs }, "post-result drain timed out");
        }
        return { action: "finish", events };
      }
      if (settled.done) {
        return { action: "finish", events };
      }

      const msg = asRecord(settled.value);
      if (msg && msg.type === "prompt_suggestion") {
        events.push(...this.eventMapper.mapPromptSuggestion(msg));
        if (this.runtimeState.hasPendingWork()) continue;
        return { action: "finish", events };
      }
      if (msg && isRuntimeSystemMessage(msg)) {
        events.push(...this.eventMapper.mapSystemMessage(msg));
        if (this.runtimeState.hasPendingWork()) continue;
        return { action: "finish", events };
      }
      if (msg?.type === "system" && msg.subtype === "compact_boundary") {
        const mapped = this.eventMapper.mapSystemMessage(msg);
        events.push(...mapped);
        if (continuations.has("compact_boundary")) {
          return { action: "continue", reason: "compact_boundary", events };
        }
        if (this.runtimeState.hasPendingWork()) continue;
        return { action: "finish", events };
      }
      if (continuations.has("tool_use")) {
        this.logger.debug?.(
          { messageType: msg?.type ?? "unknown" },
          "post-tool-use-result drain received continuation message",
        );
        if (msg?.type === "result") {
          const terminalEvents = this.eventMapper.mapResultMessage(msg);
          const resultEvent = terminalEvents.find((event) => event.type === "result");
          const nextContinuations =
            resultEvent?.type === "result"
              ? this.postResultContinuations(resultEvent, 0)
              : new Set<PostResultContinuationKind>();
          const drain = await this.drainAfterResult(queryIter, nextContinuations);
          if (drain.action === "continue") {
            events.push(...drain.events);
            return { action: "continue", reason: drain.reason, events };
          }
          events.push(...this.orderTerminalEvents(terminalEvents, drain.events));
          return { action: "continue", reason: "tool_use", events };
        }
        const mapped = this.eventMapper.mapSdkMessage(settled.value);
        events.push(...mapped);
        return { action: "continue", reason: "tool_use", events };
      }
      // Runtime이 이미 pending이면 stray 메시지 하나 때문에 query를 닫지 않는다.
      this.logger.warn?.(
        { messageType: msg?.type ?? "unknown" },
        "post-result drain received unexpected message type — ignoring",
      );
      if (this.runtimeState.hasPendingWork()) continue;
      return { action: "finish", events };
    }
  }

  orderTerminalEvents(
    terminalEvents: ClaudeClientEvent[],
    drainEvents: ClaudeClientEvent[],
  ): ClaudeClientEvent[] {
    if (drainEvents.some(isFatalClientError)) {
      return drainEvents;
    }
    if (this.runtimeState.hasPendingWork() || drainEvents.some(isRuntimeClientEvent)) {
      return [...drainEvents, ...terminalEvents];
    }
    return [...terminalEvents, ...drainEvents];
  }

  private async nextWithDrainTimeout(
    queryIter: AsyncIterator<SDKMessage>,
    waitMs: number,
  ): Promise<IteratorResult<SDKMessage> | typeof DRAIN_TIMEOUT> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<typeof DRAIN_TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(DRAIN_TIMEOUT), waitMs);
    });
    const nextPromise = queryIter.next();
    try {
      return await Promise.race([nextPromise, timeoutPromise]);
    } catch (err) {
      this.logger.debug?.({ err }, "post-result drain errored");
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private makeDrainErrorEvent(err: unknown): ClaudeClientEvent {
    const message = errorMessage(err);
    return {
      type: "error",
      fatal: !isEdeDiagnosticErrorText(message),
      errorCode: "claude_sdk_drain_error",
      message: `Claude SDK post-result drain failed: ${message}`,
    };
  }
}
