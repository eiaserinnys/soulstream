import { describe, expect, it } from "vitest";

import {
  mapAgentsGuardrailError,
  mapAgentsRunStreamEvent,
} from "../../src/engine/agents_event_mapper.js";

describe("agents_event_mapper", () => {
  it("agent_updated_stream_event를 active agent SSE로 매핑", () => {
    const events = mapAgentsRunStreamEvent({
      type: "agent_updated_stream_event",
      agent: { name: "Database specialist" },
    } as any);

    expect(events).toEqual([
      expect.objectContaining({
        type: "agent_updated",
        agent_name: "Database specialist",
        timestamp: expect.any(Number),
      }),
    ]);
  });

  it("handoff_requested / handoff_occurred를 별도 SSE로 매핑", () => {
    const requested = mapAgentsRunStreamEvent({
      type: "run_item_stream_event",
      name: "handoff_requested",
      item: {
        type: "handoff_call_item",
        agent: { name: "Triage" },
        rawItem: {
          callId: "handoff-call-1",
          name: "transfer_to_database_specialist",
          arguments: "{\"reason\":\"db cleanup\"}",
        },
      },
    } as any);
    const occurred = mapAgentsRunStreamEvent({
      type: "run_item_stream_event",
      name: "handoff_occurred",
      item: {
        type: "handoff_output_item",
        sourceAgent: { name: "Triage" },
        targetAgent: { name: "Database specialist" },
        rawItem: { callId: "handoff-call-1" },
      },
    } as any);

    expect(requested).toEqual([
      expect.objectContaining({
        type: "handoff_requested",
        source_agent: "Triage",
        target_agent: "database_specialist",
        tool_use_id: "handoff-call-1",
      }),
    ]);
    expect(occurred).toEqual([
      expect.objectContaining({
        type: "handoff_occurred",
        source_agent: "Triage",
        target_agent: "Database specialist",
        tool_use_id: "handoff-call-1",
      }),
    ]);
  });

  it("tool_approval_requested를 approval_id와 tool input을 가진 SSE로 매핑", () => {
    const events = mapAgentsRunStreamEvent({
      type: "run_item_stream_event",
      name: "tool_approval_requested",
      item: {
        type: "tool_approval_item",
        agent: { name: "Database specialist" },
        rawItem: {
          type: "function_call",
          callId: "danger-call-1",
          name: "drop_rows",
          arguments: "{\"table\":\"events\"}",
        },
      },
    } as any);

    expect(events).toEqual([
      expect.objectContaining({
        type: "tool_approval_requested",
        approval_id: "danger-call-1",
        tool_use_id: "danger-call-1",
        tool_name: "drop_rows",
        tool_input: { table: "events" },
        agent_name: "Database specialist",
      }),
    ]);
  });

  it("guardrail tripwire exception을 fatal error가 아닌 guardrail_tripwire SSE로 매핑", () => {
    const events = mapAgentsGuardrailError({
      name: "InputGuardrailTripwireTriggered",
      message: "blocked by policy",
      result: {
        guardrail: { type: "input", name: "no-prod-db" },
        output: {
          outputInfo: { matched: "prod" },
        },
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "guardrail_tripwire",
        guardrail_type: "input",
        guardrail_name: "no-prod-db",
        message: "blocked by policy",
        output_info: { matched: "prod" },
      }),
    ]);
  });
});
