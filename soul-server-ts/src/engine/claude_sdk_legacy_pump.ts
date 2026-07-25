import type { Query as ClaudeSdkQuery, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { ClaudeClientEvent } from "./claude_event_mapper.js";
import {
  ClaudePostResultDrain,
  MAX_COMPACT_RETRIES,
  type PostResultContinuationKind,
} from "./claude_sdk_drain.js";
import type { EventQueue } from "./claude_sdk_event_queue.js";
import { ClaudeSdkEventMapper } from "./claude_sdk_event_mapper.js";
import { asRecord } from "./claude_sdk_helpers.js";
import { ClaudeRuntimeState } from "./claude_sdk_runtime_state.js";

export interface PumpLegacyClaudeQueryParams {
  query: ClaudeSdkQuery;
  output: EventQueue<ClaudeClientEvent>;
  signal: AbortSignal;
  input: EventQueue<SDKUserMessage>;
  eventMapper: ClaudeSdkEventMapper;
  postResultDrainer: ClaudePostResultDrain;
  runtimeState: ClaudeRuntimeState;
  logger: Logger;
  isQueryActive(query: ClaudeSdkQuery): boolean;
  closeInput(input: EventQueue<SDKUserMessage>): void;
}

/** Legacy query-per-turn receive loop. Runtime-v2 never enters this function. */
export async function pumpLegacyClaudeQuery(
  params: PumpLegacyClaudeQueryParams,
): Promise<void> {
  const {
    query,
    output,
    signal,
    input,
    eventMapper,
    postResultDrainer,
    runtimeState,
    logger,
  } = params;
  try {
    let compactRetryCount = 0;
    for (;;) {
      const queryIter = query[Symbol.asyncIterator]();
      const compactSnapshot = eventMapper.getCompactHookEventCount();
      let sawResult = false;
      for (;;) {
        const next = await queryIter.next();
        if (next.done) {
          if (
            shouldRetryAfterCompactNoResult({
              compactSnapshot,
              compactRetryCount,
              query,
              signal,
              eventMapper,
              logger,
              isQueryActive: params.isQueryActive,
              sawResult,
            })
          ) {
            compactRetryCount += 1;
            break;
          }
          if (runtimeState.hasPendingWork()) {
            output.push({
              type: "error",
              fatal: true,
              errorCode: "claude_runtime_ended_before_idle",
              message: "Claude SDK stream ended while runtime work was still pending.",
            });
          }
          params.closeInput(input);
          output.close();
          return;
        }
        const message = next.value;
        const msg = asRecord(message);
        if (msg?.type === "result") {
          sawResult = true;
          params.closeInput(input);
          const terminalEvents = eventMapper.mapResultMessage(msg);
          const resultEvent = terminalEvents.find((event) => event.type === "result");
          const continuations =
            resultEvent?.type === "result"
              ? postResultDrainer.postResultContinuations(resultEvent, compactRetryCount)
              : new Set<PostResultContinuationKind>();
          const drain = await postResultDrainer.drainAfterResult(queryIter, continuations);

          if (drain.action === "continue") {
            if (drain.reason === "compact_boundary") compactRetryCount += 1;
            for (const event of drain.events) output.push(event);
            continue;
          }
          for (const event of postResultDrainer.orderTerminalEvents(terminalEvents, drain.events)) {
            output.push(event);
          }
          query.close();
          output.close();
          return;
        }

        let shouldStop = false;
        for (const event of eventMapper.mapSdkMessage(message)) {
          output.push(event);
          if (event.type === "complete" || (event.type === "error" && event.fatal !== false)) {
            shouldStop = true;
          }
        }
        if (!shouldStop) continue;

        params.closeInput(input);
        const drain = await postResultDrainer.drainAfterResult(
          queryIter,
          new Set<PostResultContinuationKind>(),
        );
        for (const event of drain.events) output.push(event);
        query.close();
        output.close();
        return;
      }
    }
  } catch (err) {
    output.fail(err);
    throw err;
  }
}

function shouldRetryAfterCompactNoResult(params: {
  compactSnapshot: number;
  compactRetryCount: number;
  query: ClaudeSdkQuery;
  signal: AbortSignal;
  eventMapper: ClaudeSdkEventMapper;
  logger: Logger;
  isQueryActive(query: ClaudeSdkQuery): boolean;
  sawResult: boolean;
}): boolean {
  if (params.sawResult) return false;
  if (params.eventMapper.getCompactHookEventCount() <= params.compactSnapshot) return false;
  if (params.compactRetryCount >= MAX_COMPACT_RETRIES) return false;
  const isClosed = asRecord(params.query)?.isClosed;
  const queryClosed =
    typeof isClosed === "function" && isClosed.call(params.query) === true;
  if (
    params.signal.aborted ||
    !params.isQueryActive(params.query) ||
    queryClosed
  ) {
    params.logger.warn?.(
      { compactRetryCount: params.compactRetryCount, aborted: params.signal.aborted },
      "compact retry skipped because Claude SDK query is no longer active",
    );
    return false;
  }
  params.logger.info?.(
    {
      compactRetryCount: params.compactRetryCount + 1,
      maxRetries: MAX_COMPACT_RETRIES,
    },
    "compact happened without a result; re-entering Claude SDK receive loop",
  );
  return true;
}
