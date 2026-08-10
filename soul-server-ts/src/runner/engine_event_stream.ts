import type { SSEEventPayload } from "../engine/protocol.js";
import { attachClaudeBackgroundDeliveryMetadata } from
  "../engine/claude_background_delivery_metadata.js";
import { attachClaudeBackgroundProvenance } from
  "../engine/claude_background_provenance.js";

import type { RunnerEventFrame } from "./frame_protocol.js";

export function sseEventFromRunnerFrame(
  frame: Extract<RunnerEventFrame, { kind: "engine_event" }>,
): SSEEventPayload {
  const payload = frame.payload as SSEEventPayload;
  const metadata = frame.metadata;
  if (metadata?.claudeBackgroundProvenance) {
    attachClaudeBackgroundProvenance(payload, metadata.claudeBackgroundProvenance);
  }
  if (metadata?.claudeBackgroundDelivery) {
    attachClaudeBackgroundDeliveryMetadata(payload, metadata.claudeBackgroundDelivery);
  }
  return payload;
}

/** Compatibility view for callers that still consume EnginePort SSE events directly. */
export async function* sseEventsFromRunnerFrames(
  frames: AsyncIterable<RunnerEventFrame>,
): AsyncIterable<SSEEventPayload> {
  for await (const frame of frames) {
    if (frame.kind === "engine_event") {
      yield sseEventFromRunnerFrame(frame);
    }
  }
}
