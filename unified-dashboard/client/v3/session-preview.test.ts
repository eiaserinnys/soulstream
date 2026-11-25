import { describe, expect, it } from "vitest";

import { EXECUTE_INSTRUCTION_PROMPT, PERSISTENT_INITIAL_INSTRUCTION } from "../../../packages/wire-schema/src/conversation_visibility";

import {
  codePointLength,
  hasCodePointOverflow,
  singleLinePreview,
  visibleLastMessagePreview,
  visibleSessionPreview,
} from "./session-preview";

describe("session preview text boundaries", () => {
  it("counts astral emoji as one code point", () => {
    expect(codePointLength("A😀B")).toBe(3);
    expect(hasCodePointOverflow("A😀B", 3)).toBe(false);
    expect(hasCodePointOverflow("A😀B", 2)).toBe(true);
  });

  it("never leaves an unmatched surrogate when truncating", () => {
    const preview = singleLinePreview("가😀나다라", 4);

    expect(preview).toBe("가😀나…");
    expect(preview).not.toMatch(/[\uD800-\uDBFF]$/u);
  });
});

describe("visible session preview", () => {
  const first = `${EXECUTE_INSTRUCTION_PROMPT}\n${PERSISTENT_INITIAL_INSTRUCTION}`;
  const legacyFirst = `${EXECUTE_INSTRUCTION_PROMPT}\n새 영구 에이전트 세션입니다. 도구를 쓰지 말고 짧게 인사한 뒤 다음 지시를 기다려 주십시오.`;
  const stored = (preview: string | null | undefined, prompt?: string) => ({
    lastMessage: preview === undefined ? undefined : { type: "assistant_message" as const, preview, timestamp: "2026-11-25T00:00:00Z" },
    prompt,
  });

  it("drops a stored [SILENT] preview and a first-instruction prompt", () => {
    expect(visibleSessionPreview(stored(" [SILENT]\n", first))).toBeUndefined();
    expect(visibleSessionPreview(stored(first, legacyFirst))).toBeUndefined();
  });

  it("falls to an ordinary prompt when the stored preview is hidden", () => {
    expect(visibleSessionPreview(stored("[SILENT]", "결과를 표로 정리해줘."))).toBe("결과를 표로 정리해줘.");
    expect(visibleSessionPreview(stored(undefined, "결과를 표로 정리해줘."))).toBe("결과를 표로 정리해줘.");
    expect(visibleSessionPreview(stored(null, "결과를 표로 정리해줘."))).toBe("결과를 표로 정리해줘.");
  });

  it("keeps ordinary previews, including ones that only start like the hidden text", () => {
    expect(visibleSessionPreview(stored("안녕하세요", first))).toBe("안녕하세요");
    expect(visibleSessionPreview(stored("[SILENT] 이 아닌 답"))).toBe("[SILENT] 이 아닌 답");
    expect(visibleSessionPreview(stored(undefined, `${EXECUTE_INSTRUCTION_PROMPT}\n다른 지시`))).toBe(`${EXECUTE_INSTRUCTION_PROMPT}\n다른 지시`);
    expect(visibleLastMessagePreview(stored("안녕하세요"))).toBe("안녕하세요");
    expect(visibleLastMessagePreview(stored("[SILENT]"))).toBeUndefined();
  });
});
