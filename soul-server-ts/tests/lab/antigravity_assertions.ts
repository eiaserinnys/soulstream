import assert from "node:assert/strict";
import type { AntigravityEvent, AntigravityUsage } from "../../src/engine/antigravity/events.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";

/** Lab arithmetic computed from the observed native boundary, independent of public events. */
export function rawStepUsage(events: AntigravityEvent[]): AntigravityUsage {
  const counted = new Set<number>();
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  for (const event of events) {
    const step = event.step_update;
    if (!step || step.state !== "DONE" || !step.usage || counted.has(step.step_index)) continue;
    counted.add(step.step_index);
    usage.input_tokens += (step.usage.input_tokens ?? 0) + (step.usage.cache_read_tokens ?? 0);
    usage.cached_input_tokens += step.usage.cache_read_tokens ?? 0;
    usage.output_tokens += step.usage.output_tokens ?? 0;
    usage.reasoning_output_tokens += step.usage.thinking_tokens ?? 0;
  }
  return usage;
}
export function assertTurnUsage(events: SSEEventPayload[], usage: AntigravityUsage, model?: string): void {
  const complete = events.filter(x => x.type === "complete");
  assert.equal(complete.length, 1, "Exactly one complete is required");
  assert.equal(events.some(x => x.type === "error" || x.type === "result"), false);
  assert.deepEqual(complete[0]!.usage, usage);
  assert.equal(complete[0]!.model, model);
}
export function pairedToolNames(events: SSEEventPayload[]): unknown[] {
  const starts = events.filter(x => x.type === "tool_start");
  const results = events.filter(x => x.type === "tool_result");
  for (const start of starts) {
    assert.equal(typeof start.tool_use_id, "string");
    assert.equal(results.filter(result => result.tool_use_id === start.tool_use_id).length, 1, `No unique result for ${start.tool_name}`);
  }
  return starts.map(x => x.tool_name);
}
