import { randomUUID } from "node:crypto";

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { EngineUserInput } from "./protocol.js";
import { asString } from "./claude_sdk_helpers.js";
import {
  type ActiveForeground,
  createInterventionInterruptObservation,
  describeResultProvenance,
  hashSdkUserMessage,
  makeStaleInterruptReceiptLogger,
  normalizePersistentTurnOwner,
  waitForInterventionEffect,
} from "./claude_sdk_persistent_session_support.js";
import { makeUserMessage } from "./claude_sdk_user_message.js";
import type {
  ClaudeForegroundPhase,
  ClaudeSessionRuntime,
  ClaudeRuntimeCloseReason,
} from "./claude_session_runtime.js";

type PersistentForegroundInterruptionOptions = {
  active: ActiveForeground | null;
  runtime: ClaudeSessionRuntime<SDKUserMessage>;
  logger: Logger;
  clearForegroundTimers(active: ActiveForeground): void;
  setInterventionFence(active: ActiveForeground): void;
  close(reason: ClaudeRuntimeCloseReason): Promise<void>;
};

export async function interruptPersistentForeground({
  active,
  runtime,
  logger,
  clearForegroundTimers,
  setInterventionFence,
  close,
}: PersistentForegroundInterruptionOptions): Promise<boolean> {
  if (!active || runtime.snapshot().foregroundPhase !== "generating") return false;
  if (active.interventionInterrupt) return await active.interventionInterrupt.promise;

  const observation = createInterventionInterruptObservation();
  active.interventionInterrupt = observation;
  setInterventionFence(active);
  clearForegroundTimers(active);
  try {
    return await waitForInterventionEffect(
      observation,
      () => runtime.interruptForeground(makeStaleInterruptReceiptLogger(logger)),
      logger,
      active.uuid,
    );
  } catch (error) {
    if (observation.observed) return true;
    await close("fatal");
    throw error;
  }
}

/** Feeds a raw `command_lifecycle` frame (absent from the SDK types) to the runtime ledger. */
export function observeCommandLifecycleFrame(
  runtime: ClaudeSessionRuntime<SDKUserMessage>,
  frame: Record<string, unknown>,
): void {
  const uuid = asString(frame.command_uuid);
  const state = asString(frame.state);
  if (uuid && state) runtime.observeCommandLifecycle(uuid, state);
}

type DeferForegroundResultOptions = {
  phase: ClaudeForegroundPhase;
  active: ActiveForeground;
  runtime: ClaudeSessionRuntime<SDKUserMessage>;
  message: Record<string, unknown>;
  logger: Logger;
};

/**
 * An input injected at the tool boundary while the final text is generated is
 * not consumed by that turn. The CLI ends the turn, then starts one of its own
 * for the injected input. A Result that arrives while such an input has not yet
 * started therefore ends only one CLI turn, so the foreground turn stays open
 * and its output keeps carrying the following turn until that turn's Result.
 * Returns true when the caller must leave the Result unsettled.
 */
export function deferForegroundResultForInjectedInput({
  phase,
  active,
  runtime,
  message,
  logger,
}: DeferForegroundResultOptions): boolean {
  if (phase !== "generating" || active.timedOut) return false;
  if (!runtime.hasMergedInputAwaitingStart(active.uuid)) return false;
  logger.info(
    {
      activeForegroundUuid: active.uuid,
      awaitingInputUuids: runtime.mergedInputUuidsAwaitingStart(),
      ...describeResultProvenance(message),
    },
    "Keeping the foreground turn open: the CLI will start a turn for an injected input",
  );
  return true;
}

type PersistentToolBoundaryInjectionOptions = {
  input: EngineUserInput;
  active: ActiveForeground | null;
  runtime: ClaudeSessionRuntime<SDKUserMessage>;
};

export function injectPersistentToolBoundary({
  input,
  active,
  runtime,
}: PersistentToolBoundaryInjectionOptions): boolean {
  if (!active || runtime.snapshot().foregroundPhase !== "generating") return false;
  const uuid = input.inputUuid ?? randomUUID();
  const message = makeUserMessage(input.prompt, input.imageAttachmentPaths, {
    uuid,
    priority: "next",
    origin: { kind: "coordinator" },
  });
  runtime.enqueueForegroundContinuation({
    uuid,
    payloadHash: hashSdkUserMessage(message),
    turnOwner: normalizePersistentTurnOwner(input.turnOrigin, uuid),
    message,
  });
  return true;
}
