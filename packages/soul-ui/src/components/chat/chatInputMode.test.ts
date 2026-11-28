import { getI18n } from "react-i18next";
import { describe, expect, it } from "vitest";

import { resolveChatInputMode } from "./chatInputMode";

describe("resolveChatInputMode", () => {
  it("끝난 세션은 대화 이어가기 문구를 쓴다", () => {
    expect(resolveChatInputMode({ isFinished: true, sending: false }, getI18n().t)).toMatchObject({
      placeholder: "대화를 이어서 입력하세요",
      buttonLabel: "보내기",
      modeLabel: "대화 이어가기",
      buttonVariant: "default",
    });
  });

  it("실행 중 세션은 개입 문구를 쓴다", () => {
    expect(resolveChatInputMode({ isFinished: false, sending: false }, getI18n().t)).toMatchObject({
      placeholder: "메시지를 입력하세요",
      buttonLabel: "개입",
      modeLabel: "개입",
      buttonVariant: "warning",
    });
  });

  it("보내는 중에는 버튼 라벨이 줄임표다", () => {
    expect(resolveChatInputMode({ isFinished: true, sending: true }, getI18n().t).buttonLabel).toBe("...");
  });
});
