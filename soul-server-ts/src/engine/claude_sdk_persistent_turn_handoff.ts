import { randomUUID } from "node:crypto";

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "pino";

import type { ClaudeRunOptions } from "./claude_adapter.js";
import type { ClaudeClientEvent } from "./claude_event_mapper.js";
import { createEventQueue } from "./claude_sdk_event_queue.js";
import { makeUserMessage } from "./claude_sdk_user_message.js";
import { ClaudeRuntimeFollowupWatchdog } from "./claude_runtime_followup_watchdog.js";
import type { ClaudeSessionRuntime } from "./claude_session_runtime.js";
import {
  type ActiveForeground,
  hashSdkUserMessage,
} from "./claude_sdk_persistent_session_support.js";
import { ClaudeTurnInactivityWatchdog } from "./claude_turn_inactivity_watchdog.js";
import type { EngineUserInput, LiveTurnSteerResult } from "./protocol.js";

type StartPersistentForegroundTurnOptions = {
  options: ClaudeRunOptions;
  signal: AbortSignal;
  activeForeground: ActiveForeground | null;
  runtime: ClaudeSessionRuntime<SDKUserMessage>;
  turnInactivityWatchdog: ClaudeTurnInactivityWatchdog;
  followupWatchdog: ClaudeRuntimeFollowupWatchdog;
  logger: Logger;
  setActiveForeground(active: ActiveForeground): void;
};

export function startPersistentForegroundTurn({
  options,
  signal,
  activeForeground,
  runtime,
  turnInactivityWatchdog,
  followupWatchdog,
  logger,
  setActiveForeground,
}: StartPersistentForegroundTurnOptions): AsyncIterable<ClaudeClientEvent> {
  if (!options.agentSessionId) {
    throw new Error("Persistent Claude runtime requires agentSessionId");
  }
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Persistent Claude turn aborted before enqueue");
  }
  if (activeForeground) {
    throw new Error("Persistent Claude runtime already has an active foreground turn");
  }

  const output = createEventQueue<ClaudeClientEvent>();
  const uuid = options.inputUuid ?? randomUUID();
  const message = makeUserMessage(
    options.prompt,
    options.imageAttachmentPaths,
    {
      uuid,
      priority: runtime.snapshot().foregroundPhase === "idle" ? "now" : "next",
    },
  );
  runtime.enqueueInput({
    uuid,
    payloadHash: hashSdkUserMessage(message),
    message,
  });
  const origin = {
    kind: options.turnOrigin?.kind ?? "initial_prompt",
    id: options.turnOrigin?.id ?? uuid,
  };
  const active = {
    uuid,
    output,
    interruptResultTimer: null,
    timedOut: false,
    origin,
    rateLimitTerminationState: "none",
  } satisfies ActiveForeground;
  setActiveForeground(active);
  turnInactivityWatchdog.arm(uuid);
  if (origin.kind === "runtime_followup") {
    followupWatchdog.arm(uuid, origin);
  }
  runtime.beginForegroundTurn(uuid);
  logger.info(
    { uuid, turnOriginKind: origin.kind, turnOriginId: origin.id },
    "Persistent Claude foreground turn started",
  );
  return output;
}

type SteerPersistentActiveTurnOptions = {
  input: EngineUserInput;
  activeForeground: ActiveForeground | null;
  runtime: ClaudeSessionRuntime<SDKUserMessage>;
  clearForegroundTimers(active: ActiveForeground): void;
  logger: Logger;
};

export async function steerPersistentActiveTurn({
  input,
  activeForeground,
  runtime,
  clearForegroundTimers,
  logger,
}: SteerPersistentActiveTurnOptions): Promise<LiveTurnSteerResult> {
  const active = activeForeground;
  if (!active) return { status: "no_active_turn" };
  if (runtime.snapshot().foregroundPhase !== "generating") {
    return { status: "not_accepting_input" };
  }

  const uuid = input.inputUuid ?? randomUUID();
  const message = makeUserMessage(
    input.prompt,
    input.imageAttachmentPaths,
    { uuid, priority: "next" },
  );
  const registered = runtime.enqueueInput({
    uuid,
    payloadHash: hashSdkUserMessage(message),
    message,
  });
  if (!registered) {
    return {
      status: "not_accepting_input",
      message: `Claude intervention input is already registered: ${uuid}`,
    };
  }

  const interruptedOwnerUuid = active.uuid;
  clearForegroundTimers(active);
  active.interruptedOwnerUuid = interruptedOwnerUuid;
  active.uuid = uuid;
  active.origin = {
    kind: input.turnOrigin?.kind ?? "user_message",
    id: input.turnOrigin?.id ?? uuid,
  };
  active.timedOut = false;
  active.rateLimitTerminationState = "none";
  await runtime.interruptForeground();
  logger.info(
    {
      interruptedOwnerUuid,
      interventionUuid: uuid,
      turnOriginKind: active.origin.kind,
      turnOriginId: active.origin.id,
    },
    "Persistent Claude intervention enqueued and interrupted active owner",
  );
  return { status: "delivered" };
}
