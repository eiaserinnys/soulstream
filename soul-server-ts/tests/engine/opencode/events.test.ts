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
