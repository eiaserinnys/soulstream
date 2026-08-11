import type { SSEEventPayload } from "../engine/protocol.js";
import { attachClaudeBackgroundDeliveryMetadata } from
  "../engine/claude_background_delivery_metadata.js";
import { attachClaudeBackgroundProvenance } from
  "../engine/claude_background_provenance.js";
import { markPostResultDrainEvent } from "../engine/claude_event_phase.js";

import {
  RunnerEngineEventMetadataSchema,
  type RunnerEventFrame,
} from "./frame_protocol.js";

export function sseEventFromRunnerFrame(
  frame: Extract<RunnerEventFrame, { kind: "engine_event" }>,
): SSEEventPayload {
  const payload = frame.payload as SSEEventPayload;
  restoreRunnerEngineEventMetadata(payload, frame.metadata);
  return payload;
}

export function restoreRunnerEngineEventMetadata(
  payload: object,
  value: unknown,
): void {
  if (value === undefined) return;
  const metadata = RunnerEngineEventMetadataSchema.parse(value);
  if (metadata?.claudePostResultDrain) markPostResultDrainEvent(payload);
  if (metadata?.claudeBackgroundProvenance) {
    attachClaudeBackgroundProvenance(payload, metadata.claudeBackgroundProvenance);
  }
  if (metadata?.claudeBackgroundDelivery) {
    attachClaudeBackgroundDeliveryMetadata(payload, metadata.claudeBackgroundDelivery);
  }
}

/** Compatibility view for callers that still consume EnginePort SSE events directly. */
export async function* sseEventsFromRunnerFrames(
  frames: AsyncIterable<RunnerEventFrame>,
): AsyncIterable<SSEEventPayload> {
  for await (const frame of frames) {
    if (frame.kind === "engine_event") {
      yield sseEventFromRunnerFrame(frame);
      continue;
    }
    if (frame.kind === "request") {
      if (
        frame.request.kind === "can_use_tool" ||
        frame.request.kind === "tool_approval"
      ) {
        // Compatibility callers deliver these controls asynchronously through
        // SupportsInputResponse/SupportsToolApproval. They have no SSE payload.
        continue;
      }
      throw new Error(
        "Runner request frames require executeFrames() and a control response consumer",
      );
    }
  }
}
