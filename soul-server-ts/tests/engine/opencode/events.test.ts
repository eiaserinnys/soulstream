import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  OpenCodeEventMapper,
  parseOpenCodeEvent,
} from "../../../src/engine/opencode/events.js";

function fixture(name: string) {
  return readFileSync(new URL(`./fixtures/${name}.jsonl`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map(parseOpenCodeEvent);
}

describe("OpenCode 1.19.0 event contract", () => {
  it("emits a session and completed text parts, then completes after a successful stop and exit", () => {
    const mapper = new OpenCodeEventMapper("opencode/deepseek-v4.1-flash-free");
    const mapped = fixture("plain").flatMap((event) => mapper.accept(event));
    const terminal = mapper.finish(0, null);
    const events = [...mapped, ...terminal];

    expect(events.filter((event) => event.type === "session")).toMatchObject([
      { type: "session", session_id: "ses_ebfcb6f35ffeB7uKbXfSsjChaq" },
    ]);
    expect(events.filter((event) => event.type === "assistant_message")).toMatchObject([
      { type: "assistant_message", content: "OPENCODE_OK_398" },
    ]);
    expect(mapped.some((event) => event.type === "complete")).toBe(false);
    expect(terminal).toMatchObject([
      { type: "assistant_message", content: "OPENCODE_OK_398" },
      { type: "complete", result: "OPENCODE_OK_398", turn_cost_usd: 0 },
    ]);
    expect(mapper.finish(0, null)).toEqual([]);
  });

  it("keeps tool-calls intermediate and emits each completed tool once in start/result order", () => {
    const mapper = new OpenCodeEventMapper("opencode/deepseek-v4.1-flash-free");
    const events = fixture("tool-resume").flatMap((event) => mapper.accept(event));

    expect(events.filter((event) => event.type === "complete")).toEqual([]);
    expect(events.filter((event) => event.type === "tool_start" || event.type === "tool_result"))
      .toMatchObject([
        { type: "tool_start", tool_use_id: "call_00_iwccbrioa4sk7i3jsgxgx0ll", tool_name: "read" },
        { type: "tool_result", tool_use_id: "call_00_iwccbrioa4sk7i3jsgxgx0ll", tool_name: "read", is_error: false },
      ]);
    expect(mapper.finish(0, null)).toMatchObject([
      { type: "assistant_message", content: "OPENCODE_TOOL_398\nOPENCODE_OK_398" },
      { type: "complete", result: "OPENCODE_TOOL_398\nOPENCODE_OK_398", turn_cost_usd: 0 },
    ]);
  });

  it("discards compaction text and emits only the final assistant response", () => {
    const mapper = new OpenCodeEventMapper("opencode/deepseek-v4.1-flash-free");
    const input = fixture("compaction-turn");
    const finalText = input
      .filter((event) => event.type === "text" && event.part?.type === "text" && event.part.synthetic !== true)
      .pop()?.part?.text;
    expect(finalText).toBeTypeOf("string");

    const mapped = input.flatMap((event) => mapper.accept(event));
    const terminal = mapper.finish(0, null);
    const events = [...mapped, ...terminal];

    expect(events.filter((event) => event.type === "assistant_message")).toMatchObject([
      { type: "assistant_message", content: finalText },
    ]);
    expect(events.filter((event) => event.type === "tool_start" || event.type === "tool_result"))
      .toMatchObject([
        { type: "tool_start", tool_use_id: "call_01_l0g0igkbud7xwzrbmizp5j8d", tool_name: "soulstream_get_session_name" },
        { type: "tool_result", tool_use_id: "call_01_l0g0igkbud7xwzrbmizp5j8d", tool_name: "soulstream_get_session_name", is_error: false },
        { type: "tool_start", tool_use_id: "call_00_1vl3w75vfx0tujqic3m7svur", tool_name: "read" },
        { type: "tool_result", tool_use_id: "call_00_1vl3w75vfx0tujqic3m7svur", tool_name: "read", is_error: false },
      ]);
    expect(events.filter((event) => event.type === "complete")).toMatchObject([
      { type: "complete", result: finalText, turn_cost_usd: 0 },
    ]);
    expect(events.some((event) => event.type === "compact")).toBe(false);
  });

  it("sums cost from every step_finish in the turn", () => {
    const mapper = new OpenCodeEventMapper("opencode/deepseek-v4.1-flash-free");
    mapper.accept({ type: "text", sessionID: "ses_cost", part: { type: "text", text: "answer" } });
    mapper.accept({ type: "step_finish", part: { type: "step-finish", reason: "tool-calls", cost: 0.25 } });
    mapper.accept({ type: "step_finish", part: { type: "step-finish", reason: "tool-calls", cost: 0.5 } });
    mapper.accept({ type: "step_finish", part: { type: "step-finish", reason: "stop", cost: 0.75 } });

    expect(mapper.finish(0, null)).toMatchObject([
      { type: "assistant_message", content: "answer" },
      { type: "complete", result: "answer", turn_cost_usd: 1.5 },
    ]);
  });

  it("preserves raw and normalized usage from each tool-resume step", () => {
    const mapper = new OpenCodeEventMapper("opencode/deepseek-v4.1-flash-free");
    fixture("tool-resume").forEach((event) => mapper.accept(event));

    const complete = mapper.finish(0, null).find((event) => event.type === "complete");
    expect(complete).toMatchObject({
      type: "complete",
      turn_cost_usd: 0,
      source: "opencode_step_finish",
      usage: {
        input_tokens: 6644,
        cached_input_tokens: 6400,
        cache_write_input_tokens: null,
        output_tokens: 78,
        reasoning_output_tokens: 6,
      },
      raw_usage: {
        input: 244,
        output: 72,
        reasoning: 6,
        cache_read: 6400,
        cache_write: 0,
        total: 6722,
      },
    });
  });

  it("preserves plain fixture usage while keeping zero cost separate", () => {
    const mapper = new OpenCodeEventMapper("opencode/deepseek-v4.1-flash-free");
    fixture("plain").forEach((event) => mapper.accept(event));

    const complete = mapper.finish(0, null).find((event) => event.type === "complete");
    expect(complete).toMatchObject({
      type: "complete",
      turn_cost_usd: 0,
      usage: {
        input_tokens: 3208,
        cached_input_tokens: 1792,
        cache_write_input_tokens: null,
        output_tokens: 6,
        reasoning_output_tokens: 0,
      },
      raw_usage: {
        input: 1416,
        output: 6,
        reasoning: 0,
        cache_read: 1792,
        cache_write: 0,
        total: 3214,
      },
    });
  });

  it("counts a repeated part id once and keeps later step ids", () => {
    const mapper = new OpenCodeEventMapper("opencode/deepseek-v4.1-flash-free");
    const step = (id: string, total: number, input: number, output: number, reasoning: number) => ({
      type: "step_finish",
      part: {
        id,
        messageID: `msg_${id}`,
        type: "step-finish",
        reason: "tool-calls",
        cost: 0,
        tokens: { total, input, output, reasoning, cache: { read: 0, write: 0 } },
      },
    });
    mapper.accept(step("prt_first", 15, 10, 2, 3));
    mapper.accept(step("prt_first", 15, 10, 2, 3));
    mapper.accept(step("prt_second", 7, 4, 1, 2));
    mapper.accept({
      type: "step_finish",
      part: { id: "prt_last", type: "step-finish", reason: "stop", tokens: { total: 3, input: 3, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    });

    const complete = mapper.finish(0, null).find((event) => event.type === "complete");
    expect(complete).toMatchObject({
      raw_usage: { input: 17, output: 3, reasoning: 5, cache_read: 0, cache_write: 0, total: 25 },
      usage: { input_tokens: 17, output_tokens: 8, reasoning_output_tokens: 5 },
    });
  });

  it("leaves missing raw counters and their normalized totals unknown", () => {
    const mapper = new OpenCodeEventMapper("opencode/deepseek-v4.1-flash-free");
    mapper.accept({
      type: "step_finish",
      part: {
        id: "prt_partial",
        messageID: "msg_partial",
        type: "step-finish",
        reason: "stop",
        cost: 0,
        tokens: { total: 15, input: 12, output: 3, cache: { write: 0 } },
      },
    });

    const complete = mapper.finish(0, null).find((event) => event.type === "complete");
    expect(complete).toMatchObject({
      usage: {
        input_tokens: null,
        cached_input_tokens: null,
        cache_write_input_tokens: null,
        output_tokens: null,
        reasoning_output_tokens: null,
      },
      raw_usage: {
        input: 12,
        output: 3,
        reasoning: null,
        cache_read: null,
        cache_write: 0,
        total: 15,
      },
    });
  });

  it("preserves the collected usage on a failed terminal", () => {
    const mapper = new OpenCodeEventMapper("opencode/deepseek-v4.1-flash-free");
    fixture("tool-resume").forEach((event) => mapper.accept(event));

    const failed = mapper.accept({ type: "error", error: "synthetic process failure" })
      .find((event) => event.type === "error");
    expect(failed).toMatchObject({
      type: "error",
      fatal: true,
      source: "opencode_step_finish",
      usage: {
        input_tokens: 6644,
        cached_input_tokens: 6400,
        cache_write_input_tokens: null,
        output_tokens: 78,
        reasoning_output_tokens: 6,
      },
      raw_usage: {
        input: 244,
        output: 72,
        reasoning: 6,
        cache_read: 6400,
        cache_write: 0,
        total: 6722,
      },
    });
    expect(mapper.finish(null, "SIGINT", true)).toEqual([]);
  });

  it("emits one numeric observation for an expected interrupt with bound context", () => {
    const usageSnapshot = {
      schema_version: 1,
      backend: "opencode",
      provider: "deepseek",
      preset_id: "opencode-deepseek-v4.1-flash-free",
      requested_model: "opencode/deepseek-v4.1-flash-free",
      provider_attribution: "configured_alias",
    } as const;
    const mapper = new OpenCodeEventMapper("opencode/deepseek-v4.1-flash-free", {
      commandId: "command_opencode_1",
      inputId: "input_opencode_1",
      usageSnapshot,
    });
    fixture("tool-resume").forEach((event) => mapper.accept(event));

    const interrupted = mapper.finish(null, "SIGINT", true);
    expect(interrupted).toMatchObject([
      {
        type: "assistant_message",
        content: "OPENCODE_TOOL_398\nOPENCODE_OK_398",
      },
      {
        type: "usage_observation",
        schema_version: 1,
        output_command_id: "command_opencode_1",
        input_id: "input_opencode_1",
        usage_snapshot: usageSnapshot,
        model: null,
        usage_scope: "command_delta",
        accounting_key: "command_opencode_1",
        outcome: "interrupted",
        source: "opencode_step_finish",
        usage: {
          input_tokens: 6644,
          cached_input_tokens: 6400,
          cache_write_input_tokens: null,
          output_tokens: 78,
          reasoning_output_tokens: 6,
        },
        raw_usage: {
          input: 244,
          output: 72,
          reasoning: 6,
          cache_read: 6400,
          cache_write: 0,
          total: 6722,
        },
      },
    ]);
    expect(mapper.finish(0, null)).toEqual([]);
  });

  it("does not synthesize an interrupt observation without B2 usage context", () => {
    const mapper = new OpenCodeEventMapper("opencode/deepseek-v4.1-flash-free");
    fixture("tool-resume").forEach((event) => mapper.accept(event));

    const interrupted = mapper.finish(null, "SIGINT", true);
    expect(interrupted.some((event) => event.type === "usage_observation")).toBe(false);
    expect(interrupted).toMatchObject([{ type: "assistant_message" }]);
  });

  it("flushes buffered text at tool, next text, and successful process boundaries", () => {
    const mapper = new OpenCodeEventMapper("opencode/deepseek-v4.1-flash-free");
    const first = mapper.accept({
      type: "text",
      sessionID: "ses_text_boundaries",
      part: { type: "text", text: "before tool" },
    });
    expect(first.filter((event) => event.type === "assistant_message")).toEqual([]);
    expect(mapper.accept({
      type: "step_finish",
      part: { type: "step-finish", reason: "tool-calls", cost: 0.25 },
    })).toEqual([]);

    expect(mapper.accept({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "read",
        callID: "call_text_boundary",
        state: { status: "completed", input: { filePath: "probe.txt" }, output: "probe contents" },
      },
    })).toMatchObject([
      { type: "assistant_message", content: "before tool" },
      { type: "tool_start", tool_use_id: "call_text_boundary", tool_name: "read" },
      { type: "tool_result", tool_use_id: "call_text_boundary", tool_name: "read", is_error: false },
    ]);

    expect(mapper.accept({
      type: "text",
      part: { type: "text", text: "before next text" },
    })).toEqual([]);
    expect(mapper.accept({
      type: "text",
      part: { type: "text", text: "final answer" },
    })).toMatchObject([{ type: "assistant_message", content: "before next text" }]);
    expect(mapper.accept({
      type: "step_finish",
      part: { type: "step-finish", reason: "stop", cost: 0.5 },
    })).toEqual([]);
    expect(mapper.finish(0, null)).toMatchObject([
      { type: "assistant_message", content: "final answer" },
      { type: "complete", result: "final answer", turn_cost_usd: 0.75 },
    ]);
  });

  it("flushes buffered text before a fatal process terminal", () => {
    const mapper = new OpenCodeEventMapper("opencode/deepseek-v4.1-flash-free");
    mapper.accept({
      type: "text",
      sessionID: "ses_failed_text",
      part: { type: "text", text: "last text before failure" },
    });

    expect(mapper.finish(1, null)).toMatchObject([
      { type: "assistant_message", content: "last text before failure" },
      { type: "error", fatal: true },
    ]);
  });

  it("flushes buffered text when the turn is interrupted", () => {
    const mapper = new OpenCodeEventMapper("opencode/deepseek-v4.1-flash-free");
    mapper.accept({
      type: "text",
      sessionID: "ses_interrupted_text",
      part: { type: "text", text: "last text before interrupt" },
    });

    expect(mapper.finish(null, "SIGTERM", true)).toEqual([
      expect.objectContaining({ type: "assistant_message", content: "last text before interrupt" }),
    ]);
    expect(mapper.finish(0, null)).toEqual([]);
  });

  it("converts a failed tool call to a tool result without failing the turn", () => {
    const mapper = new OpenCodeEventMapper("opencode/deepseek-v4.1-flash-free");
    const events = fixture("tool-error.synthetic").flatMap((event) => mapper.accept(event));

    expect(events.filter((event) => event.type === "tool_start" || event.type === "tool_result"))
      .toMatchObject([
        { type: "tool_start", tool_use_id: "call_tool_error_398", tool_name: "read" },
        { type: "tool_result", tool_use_id: "call_tool_error_398", tool_name: "read", is_error: true, result: "synthetic read failure" },
      ]);
    expect(mapper.accept({
      type: "step_finish",
      sessionID: "ses_synthetic_398",
      part: { type: "step-finish", reason: "stop", cost: 0 },
    })).toEqual([]);
    expect(mapper.finish(0, null)).toMatchObject([{ type: "complete" }]);
  });

  it("treats CLI errors, nonzero exit, and EOF without stop as fatal", () => {
    const cliError = new OpenCodeEventMapper("opencode/deepseek-v4.1-flash-free");
    expect(fixture("error.synthetic").flatMap((event) => cliError.accept(event)))
      .toMatchObject([
        { type: "session", session_id: "ses_synthetic_398" },
        { type: "error", fatal: true, message: "synthetic CLI failure" },
      ]);
    expect(cliError.finish(1, null)).toEqual([]);

    const nonzero = new OpenCodeEventMapper("opencode/deepseek-v4.1-flash-free");
    fixture("plain").forEach((event) => nonzero.accept(event));
    expect(nonzero.finish(1, null)).toMatchObject([
      { type: "assistant_message", content: "OPENCODE_OK_398" },
      { type: "error", fatal: true },
    ]);

    const eof = new OpenCodeEventMapper("opencode/deepseek-v4.1-flash-free");
    fixture("eof-prefix").forEach((event) => eof.accept(event));
    expect(eof.finish(0, null)).toMatchObject([
      { type: "assistant_message", content: "PARTIAL_398" },
      { type: "error", fatal: true },
    ]);
  });

  it("does not expose reasoning and rejects malformed event envelopes", () => {
    const mapper = new OpenCodeEventMapper("opencode/deepseek-v4.1-flash-free");
    expect(mapper.accept(parseOpenCodeEvent(JSON.stringify({
      type: "reasoning",
      sessionID: "ses_reasoning",
      part: { type: "reasoning", text: "PRIVATE_REASONING" },
    })))).toMatchObject([{ type: "session" }]);
    expect(() => parseOpenCodeEvent("broken")).toThrow();
    expect(() => parseOpenCodeEvent('{"part":{}}')).toThrow();
  });
});
