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
    expect(project(3, "assistant_message", { content: "hidden", input_id: "hidden" }).item).toMatchObject({kind:"assistant",text:"hidden"});
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
  it("hides old card notices and their response while retaining surrounding turns and errors", () => {
    const p = new ConversationProjection(false);
    const notice = {text:"[카드 막힘] 맡긴 카드 #953 내용",caller_info:{source:"system"},input_id:"notice"};
    const human = {text:"일반 입력",caller_info:{source:"browser"}};
    expect(p.apply(event(1,"user_message",human)).item).toMatchObject({kind:"user",text:"일반 입력"});
    expect(p.apply(event(2,"assistant_message",{content:"첫 답"})).item).toMatchObject({text:"첫 답"});
    p.apply(event(3,"complete"));
    expect(p.apply(event(4,"intervention_sent",notice)).item).toBeUndefined();
    expect(p.apply(event(5,"tool_start",{tool_name:"Read"}))).toEqual({});
    expect(p.live("text_delta",{text:"숨긴 스트림"})).toBeUndefined();
    expect(p.apply(event(6,"assistant_message",{content:"숨긴 답"})).item).toBeUndefined();
    expect(p.apply(event(7,"error",{message:"오류"})).item).toMatchObject({kind:"error",text:"오류"});
    expect(p.apply(event(8,"user_message",human)).item).toMatchObject({kind:"user",text:"일반 입력"});
    expect(p.apply(event(9,"assistant_message",{content:"다음 답"})).item).toMatchObject({text:"다음 답"});
  });
  it.each(["notice-first","human-first"])("preserves human input and output in a mixed batch: %s", order => {
    const p = new ConversationProjection(false);
    const notice = {text:"[카드 질문] 맡긴 카드 #953 내용",callerInfo:{source:"system"},input_id:"notice"};
    const human = {text:"사람 입력",caller_info:{source:"browser"},input_id:"human"};
    const entries = order === "notice-first" ? [notice,human] : [human,notice];
    const items = entries.flatMap((payload,index) => {
      const result = p.apply(event(index+1,"user_message",payload));
      return result.item ? [result.item.text] : [];
    });
    expect(items).toEqual(["사람 입력"]);
    expect(p.apply(event(3,"tool_start",{tool_name:"Read",input_id:"notice"})).activity).toMatchObject({tool:"Read"});
    expect(p.live("text_delta",{text:"응답"})).toMatchObject({text:"응답"});
    expect(p.apply(event(4,"assistant_message",{content:"완료 답",input_id:"notice"})).item).toMatchObject({text:"완료 답"});
  });
  it("shows only later output when a human intervenes after hidden output", () => {
    const p = new ConversationProjection(false);
    const inputs = [
      event(1,"user_message",{text:"[카드 완료] 맡긴 카드 #953 내용",caller_info:{source:"system"}}),
      event(2,"assistant_message",{content:"개입 전 답변"}),
      event(3,"intervention_sent",{text:"사람 개입",caller_info:{source:"browser"}}),
      event(4,"assistant_message",{content:"개입 후 답변"}),
      event(5,"complete"),
    ];
    const items = inputs.flatMap(value => { const result = p.apply(value); return result.item ? [result.item.text] : []; });
    expect(items).toEqual(["사람 개입","개입 후 답변"]);
  });
  it("does not treat a hidden notice as the first human input or reset a prior error", () => {
    const p = new ConversationProjection(true);
    p.apply(event(1,"error",{message:"실패"}));
    expect(p.hasErrorInTurn()).toBe(true);
    expect(p.apply(event(2,"user_message",{text:"[카드 완료] 맡긴 카드 #1 내용",caller_info:{source:"system"}})).item).toBeUndefined();
    expect(p.hasErrorInTurn()).toBe(true);
    expect(p.apply(event(3,"user_message",{text:"초기 지시",caller_info:{source:"browser"}})).item).toBeUndefined();
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
  it("hides the first user message while preserving an earlier intervention", () => {
    const p = new ConversationProjection(true);
    expect(p.apply(event(1, "intervention_sent", { text: "sent before startup", caller_info: { source: "browser" } })).item)
      .toMatchObject({ kind: "user", text: "sent before startup" });
    expect(p.apply(event(2, "user_message", { text: "initial instruction", caller_info: { source: "browser" } })).item)
      .toBeUndefined();
    expect(p.apply(event(3, "user_message", { text: "follow-up", caller_info: { source: "browser" } })).item)
      .toMatchObject({ kind: "user", text: "follow-up" });
  });
  it("keeps the existing order where the initial user message arrives first", () => {
    const p = new ConversationProjection(true);
    expect(p.apply(event(1, "user_message", { text: "initial instruction", caller_info: { source: "browser" } })).item)
      .toBeUndefined();
    expect(p.apply(event(2, "intervention_sent", { text: "follow-up", caller_info: { source: "browser" } })).item)
      .toMatchObject({ kind: "user", text: "follow-up" });
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
