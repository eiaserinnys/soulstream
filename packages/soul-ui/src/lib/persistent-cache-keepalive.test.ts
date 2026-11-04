import { beforeEach, describe, expect, it } from "vitest";
import type { EventTreeNode, SoulSSEEvent } from "@shared/types";
import { flattenTree, clearFlattenTreeCache } from "./flatten-tree";
import { projectPersistentChatDisplayMessages } from "./persistent-jev-candidates";
import { projectPersistentTurnUsage } from "./persistent-turn-usage-projection";
import { createNodeFromEvent } from "../stores/node-factory";
import { projectHiddenInputTurns } from "./persistent-cache-keepalive";

const keepaliveText = "캐시 유지용 호출입니다. 도구를 쓰지 말고 '[SILENT]'만 답하십시오.";

describe("card notice turn projection", () => {
  type Row = { treeNodeType: string; content: string; inputId?: string; cardNotice?: boolean; cacheKeepalive?: boolean };
  const input = (id: string, cardNotice = false): Row => ({ treeNodeType: "user_message", inputId: id, cardNotice, content: id });
  const row = (type: string, content: string, inputId?: string): Row => ({ treeNodeType: type, content, inputId });
  const project = (messages: Row[]) => projectHiddenInputTurns(messages);

  it("hides a notice turn including tool, stream and terminal while retaining divider and error", () => {
    const notice = input("notice", true);
    const result = project([notice, row("tool", "tool"), row("thinking", "thinking"), row("text", "stream"), row("generation_started", "divider"), row("error", "error")]);
    expect(result.messages.map(item => item.content)).toEqual(["divider", "error"]);
    expect(result.suppressStreaming).toBe(false);
    expect(project([notice, row("tool", "tool")]).suppressStreaming).toBe(true);
    expect(project([notice, row("complete", "complete")]).messages).toEqual([]);
  });

  it("retains ordinary turns around a notice and hides a late notice anchor", () => {
    const result = project([input("before"), row("text", "before answer"), row("complete", "before end"), input("notice", true), row("text", "hidden"), row("complete", "hidden end"), row("debug", "late", "notice"), input("after"), row("text", "after answer")]);
    expect(result.messages.map(item => item.content)).toEqual(["before", "before answer", "before end", "after", "after answer"]);
  });

  it.each([false, true])("a visible input interrupts a notice (prior output: %s)", (hasPriorOutput) => {
    const events = [input("notice", true), ...(hasPriorOutput ? [row("text", "hidden before")] : []), input("human"), row("text", "visible answer", "notice")];
    const result = project(events);
    expect(result.messages.map(item => item.content)).toEqual(["human", "visible answer"]);
    expect(result.suppressStreaming).toBe(false);
  });

  it("only hides the notice bubble when a visible input came first", () => {
    const result = project([input("human"), input("notice", true), row("text", "answer", "notice"), row("complete", "end")]);
    expect(result.messages.map(item => item.content)).toEqual(["human", "answer", "end"]);
    expect(result.suppressStreaming).toBe(false);
  });

  it("retains the existing keepalive behavior when a visible input came first", () => {
    const result = project([input("human"), { ...input("keepalive"), cacheKeepalive: true }, row("text", "hidden"), row("complete", "end")]);
    expect(result.messages.map(item => item.content)).toEqual(["human"]);
  });
});

function transcript(events: SoulSSEEvent[]): ReturnType<typeof flattenTree> {
  const root: EventTreeNode = {
    type: "session",
    id: "session-root",
    content: "",
    completed: false,
    children: events.flatMap((event, index) => {
      const node = createNodeFromEvent(event, index + 1);
      return node ? [node] : [];
    }),
  };
  return flattenTree(root, { includePersistentTurnUsage: true });
}

describe("cache keepalive transcript projection", () => {
  beforeEach(() => clearFlattenTreeCache());

  it("hides the marked turn and its end captions while retaining adjacent human turns and cumulative cost", () => {
    const flattened = transcript([
      { type: "user_message", input_id: "before", text: "앞 사람 입력" },
      { type: "assistant_message", content: "앞 사람 답" },
      { type: "complete", result: "done", attachments: [], session_cost_usd: 0.01, turn_cost_usd: 0.01 },
      { type: "user_message", input_id: "keepalive", text: keepaliveText, purpose: "cache_keepalive" },
      { type: "generation_started", context_reset: true },
      { type: "assistant_message", content: "[SILENT]" },
      { type: "complete", result: "done", attachments: [], session_cost_usd: 0.04, turn_cost_usd: 0.03 },
      {
        type: "debug",
        kind: "persistent_instruction_recorded",
        input_id: "keepalive",
        timestamp: 1700000000,
        instructions: [{ id: "record-1", text: "간결하게 답합니다.", source_turns: ["T1"], action: "added" }],
        cap_reached: false,
      },
      { type: "user_message", input_id: "after", text: keepaliveText },
      { type: "generation_started", context_reset: true },
      { type: "assistant_message", content: "같은 글의 사람 답" },
      { type: "complete", result: "done", attachments: [], session_cost_usd: 0.05, turn_cost_usd: 0.01 },
    ] as SoulSSEEvent[]);
    const messages = projectPersistentTurnUsage(flattened, "collapsed");

    const keepaliveComplete = messages.find((message) =>
      message.treeNodeType === "complete" && message.sessionCostUsd === 0.04,
    );
    expect(keepaliveComplete?.persistentInstructionRecorded).toBeDefined();
    expect(messages.find((message) => message.inputId === "keepalive")?.cacheKeepalive).toBe(true);

    const visible = projectPersistentChatDisplayMessages(messages, {
      show_generation_separator: true,
      show_jev_candidates: false,
    });

    expect(visible.map((message) => message.content)).toEqual([
      "앞 사람 입력",
      "앞 사람 답",
      "턴 완료",
      "새 세대",
      keepaliveText,
      "새 세대",
      "같은 글의 사람 답",
      "턴 완료",
    ]);
    expect(visible.filter((message) => message.treeNodeType === "generation_started")).toHaveLength(2);
    expect(visible.some((message) => message.content === "ok")).toBe(false);
    expect(visible.find((message) => message.treeNodeType === "complete" && message.sessionCostUsd === 0.05)?.sessionCostUsd).toBe(0.05);
    expect(visible.some((message) => message.persistentInstructionRecorded !== undefined)).toBe(false);
  });

  it("keeps a generation divider after the keepalive complete visible", () => {
    const messages = projectPersistentTurnUsage(transcript([
      { type: "user_message", input_id: "keepalive", text: keepaliveText, purpose: "cache_keepalive" },
      { type: "assistant_message", content: "[SILENT]" },
      { type: "complete", result: "done", attachments: [], turn_cost_usd: 0.01 },
      { type: "generation_started", context_reset: true },
      { type: "user_message", input_id: "human", text: "사람 입력" },
      { type: "assistant_message", content: "사람 답" },
      { type: "complete", result: "done", attachments: [], turn_cost_usd: 0.02 },
    ] as SoulSSEEvent[]), "collapsed");

    const visible = projectPersistentChatDisplayMessages(messages, {
      show_generation_separator: true,
      show_jev_candidates: true,
    });
    expect(visible.map((message) => message.treeNodeType)).toContain("generation_started");
    expect(visible.map((message) => message.content)).toContain("사람 입력");
    expect(visible.map((message) => message.content)).toContain("사람 답");
  });

  it("keeps unanchored rows after complete but hides rows anchored to the keepalive input", () => {
    const messages = projectPersistentTurnUsage(transcript([
      { type: "user_message", input_id: "keepalive", text: keepaliveText, purpose: "cache_keepalive" },
      { type: "assistant_message", content: "ok" },
      { type: "complete", result: "done", attachments: [], turn_cost_usd: 0.01 },
      { type: "system_message", text: "unanchored after complete" },
      {
        type: "debug",
        kind: "persistent_instruction_recorded",
        input_id: "keepalive",
        timestamp: 1700000000,
        instructions: [{ id: "record-1", text: "hidden caption", source_turns: ["T1"], action: "added" }],
        cap_reached: false,
      },
      {
        type: "debug",
        kind: "persistent_jev_candidates",
        timestamp: 1700000001,
        observation: {
          input_id: "keepalive",
          selected: [],
          candidate_counts: { turn_summaries: 0, cards: 0, search_sessions: 0, recent_completed_sessions: 0 },
          model: "jev-latest",
          latency_ms: 20,
          top_raw_score: 1.9,
        },
      },
      { type: "user_message", input_id: "human", text: "사람 입력" },
    ] as SoulSSEEvent[]), "collapsed");

    const visible = projectPersistentChatDisplayMessages(messages, {
      show_generation_separator: true,
      show_jev_candidates: true,
    });
    expect(visible.some((message) => message.content === "unanchored after complete")).toBe(true);
    expect(visible.some((message) => message.treeNodeType === "persistent_jev_candidates")).toBe(false);
    expect(visible.some((message) => message.persistentInstructionRecorded !== undefined)).toBe(false);
  });

  it("keeps a keepalive error row visible while hiding its input", () => {
    const messages = projectPersistentTurnUsage(transcript([
      { type: "user_message", input_id: "keepalive", text: keepaliveText, purpose: "cache_keepalive" },
      { type: "error", error: "rate limited", is_error: true },
    ] as SoulSSEEvent[]), "collapsed");

    const visible = projectPersistentChatDisplayMessages(messages, {
      show_generation_separator: true,
      show_jev_candidates: true,
    });
    expect(visible.some((message) => message.treeNodeType === "user_message")).toBe(false);
    expect(visible.some((message) => message.treeNodeType === "error")).toBe(true);
  });
});
