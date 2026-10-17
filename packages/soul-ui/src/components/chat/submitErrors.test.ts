import { describe, expect, it } from "vitest";
import { extractErrorMessage } from "./submitErrors";

describe("extractErrorMessage", () => {
  it("reads the nested error message for a closed card question instead of the raw object", () => {
    expect(
      extractErrorMessage(
        { detail: { error: { code: "CARD_QUESTION_CLOSED", message: "이미 닫힌 질문입니다" } } },
        409,
      ),
    ).toBe("이미 닫힌 질문입니다");
  });
});
