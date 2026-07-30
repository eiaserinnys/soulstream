import { describe, expect, it } from "vitest";

import {
  extractPreviewText,
  extractSearchableText,
} from "../../src/db/event_persistence.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";

describe("extractPreviewText", () => {
  it("text_delta는 live transport라 last_message preview에 쓰지 않는다", () => {
    expect(
      extractPreviewText({ type: "text_delta", text: "hello" } as SSEEventPayload),
    ).toBe("");
  });
  it("thinking은 thinking 필드", () => {
    expect(
      extractPreviewText({ type: "thinking", thinking: "..." } as SSEEventPayload),
    ).toBe("...");
  });
  it("complete은 turn metadata라 last_message preview에 쓰지 않는다", () => {
    expect(
      extractPreviewText({ type: "complete", result: "done" } as SSEEventPayload),
    ).toBe("");
  });
  it("error는 message 필드", () => {
    expect(
      extractPreviewText({ type: "error", message: "err" } as SSEEventPayload),
    ).toBe("err");
  });
  it("매핑 없는 event는 빈 문자열", () => {
    expect(
      extractPreviewText({ type: "tool_start" } as SSEEventPayload),
    ).toBe("");
  });
  it("prompt_suggestion과 credential_alert는 preview에 쓰지 않는다", () => {
    expect(
      extractPreviewText({ type: "prompt_suggestion", text: "next" } as SSEEventPayload),
    ).toBe("");
    expect(
      extractPreviewText({ type: "credential_alert", utilization: 0.95 } as SSEEventPayload),
    ).toBe("");
  });
  it("input_request lifecycle events는 preview와 search에 쓰지 않는다", () => {
    for (const event of [
      { type: "input_request", request_id: "ask-1", questions: [{ question: "Q" }] },
      { type: "input_request_responded", request_id: "ask-1" },
      { type: "input_request_expired", request_id: "ask-1" },
    ] as SSEEventPayload[]) {
      expect(extractPreviewText(event)).toBe("");
      expect(extractSearchableText(event)).toBe("");
    }
  });
  it("text_end는 text 필드가 없으므로 빈 문자열", () => {
    expect(extractPreviewText({ type: "text_end" } as SSEEventPayload)).toBe("");
  });
  it("realtime_transcript는 text 필드를 preview/search에 사용한다", () => {
    const event = {
      type: "realtime_transcript",
      text: "음성 응답",
      role: "assistant",
    } as SSEEventPayload;
    expect(extractPreviewText(event)).toBe("음성 응답");
    expect(extractSearchableText(event)).toBe("음성 응답");
  });
});
