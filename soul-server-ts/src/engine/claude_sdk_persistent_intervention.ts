import { randomUUID } from "node:crypto";

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { EngineUserInput } from "./protocol.js";
import {
  type ActiveForeground,
  createInterventionInterruptObservation,
  hashSdkUserMessage,
  makeStaleInterruptReceiptLogger,
  waitForInterventionEffect,
} from "./claude_sdk_persistent_session_support.js";
import { makeUserMessage } from "./claude_sdk_user_message.js";
import type { ClaudeSessionRuntime, ClaudeRuntimeCloseReason } from "./claude_session_runtime.js";

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
    message,
  });
  return true;
}
