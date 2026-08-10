import type { SSEEventPayload } from "../engine/protocol.js";

import type { RunnerEventFrame } from "./frame_protocol.js";

/** Compatibility view for callers that still consume EnginePort SSE events directly. */
export async function* sseEventsFromRunnerFrames(
  frames: AsyncIterable<RunnerEventFrame>,
): AsyncIterable<SSEEventPayload> {
  for await (const frame of frames) {
    if (frame.kind === "engine_event") {
      yield frame.payload as SSEEventPayload;
    }
  }
}
