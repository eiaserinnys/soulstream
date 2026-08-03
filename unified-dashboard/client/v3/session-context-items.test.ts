import { describe, expect, it } from "vitest";

import { buildSessionContextSelection } from "./session-context-items";

describe("session context item selection", () => {
  it("keeps project inheritance out of the payload while including explicitly selected documents", () => {
    expect(buildSessionContextSelection({
      inheritCard: true,
      taskPageId: "task-page",
      documentPageIds: ["doc-a", "task-page", "doc-b"],
      atomNode: null,
      guidance: "",
    })).toEqual({
      needsPageAnchor: true,
      contextItems: [{
        key: "page_context_sources",
        label: "업무 카드와 선택한 보드 문서",
        content: { pages: [
          { page_id: "task-page" },
          { page_id: "doc-a" },
          { page_id: "doc-b" },
        ] },
      }],
    });
  });

  it("creates session-only document, atom, and guidance items without inheriting the card", () => {
    expect(buildSessionContextSelection({
      inheritCard: false,
      taskPageId: "task-page",
      documentPageIds: ["doc-a"],
      atomNode: { nodeId: "atom-node", title: "소울스트림" },
      guidance: "  결과부터 간결하게 보고한다.  ",
    })).toEqual({
      needsPageAnchor: true,
      contextItems: [
        {
          key: "page_context_sources",
          label: "선택한 보드 문서",
          content: { pages: [{ page_id: "doc-a" }] },
        },
        {
          key: "atom_context_sources",
          label: "선택한 atom 노드",
          content: {
            nodes: [{ node_id: "atom-node", depth: 3, titles_only: false }],
          },
        },
        {
          key: "session_guidance",
          label: "추가 지침",
          content: "결과부터 간결하게 보고한다.",
        },
      ],
    });
  });

  it("labels the task page alone as card content", () => {
    expect(buildSessionContextSelection({
      inheritCard: true,
      taskPageId: "task-page",
      documentPageIds: [],
      atomNode: null,
      guidance: "",
    })).toEqual({
      needsPageAnchor: true,
      contextItems: [{
        key: "page_context_sources",
        label: "업무 카드 본문",
        content: { pages: [{ page_id: "task-page" }] },
      }],
    });
  });

  it("does not create empty context items or a page anchor", () => {
    expect(buildSessionContextSelection({
      inheritCard: false,
      taskPageId: "task-page",
      documentPageIds: [],
      atomNode: null,
      guidance: "   ",
    })).toEqual({ needsPageAnchor: false, contextItems: [] });
  });

  it("does not create a page anchor for atom and guidance alone", () => {
    const result = buildSessionContextSelection({
      inheritCard: false,
      taskPageId: "task-page",
      documentPageIds: [],
      atomNode: { nodeId: "atom-node", title: "소울스트림" },
      guidance: "검증한다.",
    });

    expect(result.needsPageAnchor).toBe(false);
    expect(result.contextItems.map((item) => item.key)).toEqual([
      "atom_context_sources",
      "session_guidance",
    ]);
  });
});
