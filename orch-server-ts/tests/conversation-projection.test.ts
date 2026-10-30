import { describe, expect, it } from "vitest";
import { ConversationProjection } from "../src/conversation/conversation_projection.js";

const at = "2026-10-30T00:00:00.000Z";
function event(id: number, type: string, payload: Record<string, unknown> = {}) {
  return { id, type, at, payload };
}

describe("conversation projection", () => {
  it("preserves human messages and applies visibility by input and turn", () => {
    const p = new ConversationProjection(true);
    const project = (id: number, type: string, payload: Record<string, unknown>) => p.apply(event(id, type, payload));
    expect(project(1, "user_message", { text: "any initial text", caller_info: { source: "browser" } }).item).toBeUndefined();
    expect(project(2, "user_message", { text: "keep", purpose: "cache_keepalive", input_id: "hidden" }).item).toBeUndefined();
    expect(project(3, "assistant_message", { content: "hidden", input_id: "hidden" }).item).toBeUndefined();
    expect(project(4, "error", { message: "real error" }).item).toMatchObject({ kind: "error", text: "real error" });
    expect(project(5, "intervention_sent", { text: "human", caller_info: { source: "browser" } }).item).toMatchObject({ kind: "user", text: "human" });
    expect(project(6, "user_message", { text: "agent", caller_info: { source: "agent" } }).item).toBeUndefined();
    expect(project(7, "assistant_message", { content: "네." }).item).toBeUndefined();
    expect(project(8, "user_message", { text: "new client", caller_info: { source: "external-human" } }).item).toMatchObject({ kind: "user" });
    expect(project(9, "assistant_message", { content: "[SILENT]" }).item).toBeUndefined();
    expect(project(10, "assistant_message", { content: "answer" }).item).toMatchObject({ id: "10", kind: "assistant", text: "answer", at, attachments: [] });
    expect(project(11, "user_message", { text: "legacy agent report", agent_info: { source: "agent" } }).item).toBeUndefined();
    expect(project(12, "assistant_message", { content: "네." }).item).toBeUndefined();
  });
  it("uses display metadata for context-bearing messages and keeps legacy event text", () => {
    const p=new ConversationProjection(false);
    expect(p.apply(event(1,"intervention_sent",{text:"visible\n\nagent context",_conversation_text:"visible"})).item)
      .toMatchObject({kind:"user",text:"visible"});
    expect(p.apply(event(2,"intervention_sent",{text:"legacy"})).item)
      .toMatchObject({kind:"user",text:"legacy"});
    expect(p.apply(event(3,"user_message",{text:"visible\n\nagent context",caller_info:{source:"browser"},_conversation_text:"visible"})).item)
      .toMatchObject({kind:"user",text:"visible"});
    expect(p.apply(event(4,"user_message",{text:"legacy",caller_info:{source:"browser"}})).item)
      .toMatchObject({kind:"user",text:"legacy"});
  });
  it("keeps busy through session_ended and clears it on complete and error", () => {
    const p = new ConversationProjection(false);
    p.apply(event(1, "user_message", { text: "hello" }));
    p.apply(event(2, "tool_start", { tool_name: "read" }));
    expect(p.activity()).toEqual({ busy: true, tool: "read" });
    p.apply(event(3, "session_ended"));
    expect(p.activity()).toEqual({ busy: true, tool: "read" });
    p.apply(event(4, "complete"));
    expect(p.activity()).toEqual({ busy: false, tool: null });
  });
});
