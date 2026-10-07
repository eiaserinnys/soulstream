import { beforeEach, describe, expect, it } from "vitest";
import type { EventTreeNode, SoulSSEEvent } from "@shared/types";
import { flattenTree, clearFlattenTreeCache } from "./flatten-tree";
import { projectPersistentChatDisplayMessages } from "./persistent-jev-candidates";
import { projectPersistentTurnUsage } from "./persistent-turn-usage-projection";
import { createNodeFromEvent } from "../stores/node-factory";

const keepaliveText = "캐시 유지용 호출입니다. 도구를 쓰지 말고 'ok'만 답하십시오.";

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
      { type: "assistant_message", content: "ok" },
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
    const messages = projectPersistentTurnUsage(flattened, true);

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
      keepaliveText,
      "새 세대",
      "같은 글의 사람 답",
      "턴 완료",
    ]);
    expect(visible.some((message) => message.contextReset)).toBe(true);
    expect(visible.find((message) => message.treeNodeType === "complete" && message.sessionCostUsd === 0.05)?.sessionCostUsd).toBe(0.05);
    expect(visible.some((message) => message.persistentInstructionRecorded !== undefined)).toBe(false);
  });
});
