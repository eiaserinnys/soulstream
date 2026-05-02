/**
 * estimate-height 테스트
 *
 * @chenglou/pretext를 모킹하여 deterministic 높이 계산을 검증한다.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// pretext를 모킹: prepare → opaque handle, layout → 텍스트 길이 기반 근사
vi.mock("@chenglou/pretext", () => {
  // prepare가 반환하는 핸들에 원본 텍스트와 font를 숨겨둔다
  const prepare = vi.fn((text: string, _font: string) => ({
    __text: text,
    __brand: true,
  }));

  const layout = vi.fn((prepared: { __text: string }, maxWidth: number, lineHeight: number) => {
    const text = prepared.__text || "";
    if (!text) return { lineCount: 0, height: 0 };
    // 간단한 근사: 8px per char, 줄 바꿈 포함
    const charsPerLine = Math.max(Math.floor(maxWidth / 8), 1);
    const textLines = text.split("\n");
    let totalLines = 0;
    for (const line of textLines) {
      totalLines += Math.max(Math.ceil(line.length / charsPerLine), 1);
    }
    return { lineCount: totalLines, height: totalLines * lineHeight };
  });

  return { prepare, layout };
});

import {
  estimateItemHeight,
  clearPrepareCache,
  parseMarkdownBlocks,
  markdownHeight,
  contentWidthFrom,
  FONT,
  LINE_HEIGHT,
  PAD,
} from "./estimate-height";
import type { MessageOrGroup } from "./grouping";
import type { ChatMessage } from "./flatten-tree";

// ─── 헬퍼 ────────────────────────────────────────────────

function makeMsg(overrides: Partial<ChatMessage> & Pick<ChatMessage, "role">): ChatMessage {
  return {
    id: "test-1",
    content: "",
    treeNodeId: "node-1",
    treeNodeType: "text",
    ...overrides,
  } as ChatMessage;
}

function single(msg: ChatMessage): MessageOrGroup {
  return { type: "single", msg };
}

function toolGroup(msgs: ChatMessage[]): MessageOrGroup {
  return { type: "tool-group", messages: msgs };
}

const CONTAINER_W = 600;
const CONTENT_W = contentWidthFrom(CONTAINER_W); // 536

beforeEach(() => {
  clearPrepareCache();
});

// ─── parseMarkdownBlocks ─────────────────────────────────

describe("parseMarkdownBlocks", () => {
  it("빈 문자열", () => {
    expect(parseMarkdownBlocks("")).toEqual([]);
  });

  it("단일 paragraph", () => {
    const blocks = parseMarkdownBlocks("Hello world");
    expect(blocks).toEqual([{ type: "paragraph", text: "Hello world" }]);
  });

  it("heading 파싱", () => {
    const blocks = parseMarkdownBlocks("# Title\n## Subtitle\n### H3\n#### H4");
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toEqual({ type: "heading", level: 1, text: "Title" });
    expect(blocks[1]).toEqual({ type: "heading", level: 2, text: "Subtitle" });
    expect(blocks[2]).toEqual({ type: "heading", level: 3, text: "H3" });
    expect(blocks[3]).toEqual({ type: "heading", level: 4, text: "H4" });
  });

  it("코드 블록 파싱", () => {
    const md = "```ts\nconst x = 1;\nconst y = 2;\n```";
    const blocks = parseMarkdownBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: "code", text: "const x = 1;\nconst y = 2;" });
  });

  it("리스트 파싱", () => {
    const md = "- item 1\n- item 2\n- item 3";
    const blocks = parseMarkdownBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: "list", items: ["item 1", "item 2", "item 3"] });
  });

  it("인용 파싱", () => {
    const md = "> line 1\n> line 2";
    const blocks = parseMarkdownBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: "blockquote", text: "line 1\nline 2" });
  });

  it("HR 파싱", () => {
    const blocks = parseMarkdownBlocks("---");
    expect(blocks).toEqual([{ type: "hr" }]);
  });

  it("테이블 파싱", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |";
    const blocks = parseMarkdownBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: "table", rows: 3 });
  });

  it("복합 마크다운", () => {
    const md = [
      "# Title",
      "",
      "Some text here.",
      "",
      "```js",
      "code()",
      "```",
      "",
      "- list item",
      "",
      "> quote",
    ].join("\n");
    const blocks = parseMarkdownBlocks(md);
    expect(blocks.map((b) => b.type)).toEqual([
      "heading", "paragraph", "code", "list", "blockquote",
    ]);
  });
});

// ─── estimateItemHeight: 메시지 타입별 ───────────────────

describe("estimateItemHeight", () => {
  it("ToolMessage 단독 → 20px", () => {
    const msg = makeMsg({ role: "tool", content: "tool_use: read_file" });
    expect(estimateItemHeight(single(msg), CONTAINER_W)).toBe(20);
  });

  it("ToolCallGroup 접힌 → 24px", () => {
    const msgs = [
      makeMsg({ role: "tool", id: "t1", content: "a" }),
      makeMsg({ role: "tool", id: "t2", content: "b" }),
    ];
    expect(estimateItemHeight(toolGroup(msgs), CONTAINER_W)).toBe(24);
  });

  it("SystemPromptMessage 접힌 → 28px", () => {
    const msg = makeMsg({ role: "system_message", content: "system prompt" });
    expect(estimateItemHeight(single(msg), CONTAINER_W)).toBe(28);
  });

  it("SystemMessage 에러 1줄: outer(8) + inner(8) + text(16) = 32", () => {
    const msg = makeMsg({
      role: "system",
      content: "Error occurred",
      isError: true,
      treeNodeType: "error",
    });
    const h = estimateItemHeight(single(msg), CONTAINER_W);
    // 8(outerPadY) + 8(innerPadY) + 16(1 line xs) = 32
    expect(h).toBe(32);
  });

  it("SystemMessage complete with CollapsibleContent", () => {
    const content = "line1\nline2\nline3\nline4\nline5";
    const msg = makeMsg({
      role: "system",
      content,
      treeNodeType: "complete",
    });
    const h = estimateItemHeight(single(msg), CONTAINER_W);
    // outerPadY(8) + labelH(sm 20 + mb 2 = 22) + pre 3줄(3*16 + 12 = 60)
    expect(h).toBe(8 + 22 + 60);
  });

  it("AssistantMessage 짧은 텍스트", () => {
    const msg = makeMsg({
      role: "assistant",
      content: "Hello",
      treeNodeType: "text",
    });
    const h = estimateItemHeight(single(msg), CONTAINER_W);
    // outerPadY(8) + header(26) + paragraph("Hello" 1줄 22 + mb 8) = 64
    expect(h).toBe(8 + 26 + 22 + 8);
  });

  it("AssistantMessage 스트리밍", () => {
    const msg = makeMsg({
      role: "assistant",
      content: "streaming text",
      treeNodeType: "text",
      isStreaming: true,
    });
    const h = estimateItemHeight(single(msg), CONTAINER_W);
    // outerPadY(8) + header(26) + textHeight(1 line baseSnug 22)
    expect(h).toBe(8 + 26 + 22);
  });

  it("UserMessage: AssistantMessage + contextItems", () => {
    const msg = makeMsg({
      role: "user",
      content: "Hello",
      treeNodeType: "user_message",
      contextItems: [{ type: "file", name: "test.ts" }] as any,
    });
    const h = estimateItemHeight(single(msg), CONTAINER_W);
    // assistant estimate + 26 (ContextBlock: mt-1.5(6) + button(20))
    const assistantH = 8 + 26 + 22 + 8; // 64
    expect(h).toBe(assistantH + 26);
  });

  it("InterventionMessage 여러 줄", () => {
    const msg = makeMsg({
      role: "intervention",
      content: "line1\nline2\nline3",
    });
    const h = estimateItemHeight(single(msg), CONTAINER_W);
    // outerPadY(8) + header(26) + textHeight(3줄 = 3*22 = 66)
    expect(h).toBe(8 + 26 + 66);
  });

  it("ThinkingMessage 접힌 상태", () => {
    const msg = makeMsg({
      role: "assistant",
      content: "thought 1\nthought 2\nthought 3\nthought 4",
      treeNodeType: "thinking",
    });
    const h = estimateItemHeight(single(msg), CONTAINER_W);
    // outerPadY(8) + labelH(22) + pre 3줄(3*16 + 12 = 60) = 90
    expect(h).toBe(90);
  });

  it("ChatInputRequest", () => {
    const msg = makeMsg({
      role: "input_request",
      content: "",
      questions: [{
        question: "Continue?",
        options: [{ label: "Yes" }, { label: "No" }],
      }] as any,
    });
    const h = estimateItemHeight(single(msg), CONTAINER_W);
    // outerPadY(8) + label(20) + headerH(0) + questionTextH(24+8=32) + buttons(28) = 88
    expect(h).toBe(8 + 20 + 0 + 32 + 28);
  });

  it("빈 content SystemMessage → 최소 높이 (padding만)", () => {
    const msg = makeMsg({
      role: "system",
      content: "",
      treeNodeType: "error",
    });
    const h = estimateItemHeight(single(msg), CONTAINER_W);
    // outerPadY(8) + innerPadY(8) + text(0) = 16
    expect(h).toBe(16);
  });

  it("알 수 없는 role → fallback 80px", () => {
    const msg = makeMsg({
      role: "unknown_role" as any,
      content: "test",
    });
    expect(estimateItemHeight(single(msg), CONTAINER_W)).toBe(80);
  });
});

// ─── markdownHeight ──────────────────────────────────────

describe("markdownHeight", () => {
  it("빈 문자열 → 0", () => {
    expect(markdownHeight("", CONTENT_W, "test")).toBe(0);
  });

  it("h1 + paragraph + code 합산", () => {
    const md = "# Title\n\nSome text.\n\n```\ncode()\n```";
    const h = markdownHeight(md, CONTENT_W, "test");
    // h1: textHeight("Title", xlBold, 28, w) + 20(margin)
    // paragraph: textHeight("Some text.", base, 22, w) + 8(mb)
    // code: min(textHeight("code()", xsMono, 16, w-16) + 12, 252) + 12(my)
    // 각 값은 mock에 의해 결정적
    expect(h).toBeGreaterThan(0);
    expect(typeof h).toBe("number");
  });

  it("HR → 25px", () => {
    const h = markdownHeight("---", CONTENT_W, "test");
    expect(h).toBe(25); // 24(my-3) + 1(border)
  });
});

// ─── contentWidthFrom ────────────────────────────────────

describe("contentWidthFrom", () => {
  it("600px 컨테이너 → 536px", () => {
    expect(contentWidthFrom(600)).toBe(536);
  });

  it("최소 100px 보장", () => {
    expect(contentWidthFrom(50)).toBe(100);
  });
});
