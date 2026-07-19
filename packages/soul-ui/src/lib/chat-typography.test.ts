import { describe, expect, it } from "vitest";

import {
  CHAT_FONT_SIZE_STEPS,
  DEFAULT_CHAT_FONT_SIZE,
  normalizeChatFontSize,
  resolveChatTypography,
} from "./chat-typography";

describe("chat typography", () => {
  it("owns the five exact font-size and line-height steps", () => {
    expect(CHAT_FONT_SIZE_STEPS).toEqual([14, 15, 16, 17, 18]);
    expect(CHAT_FONT_SIZE_STEPS.map(resolveChatTypography)).toEqual([
      { fontSize: 14, lineHeight: 22 },
      { fontSize: 15, lineHeight: 23 },
      { fontSize: 16, lineHeight: 24 },
      { fontSize: 17, lineHeight: 25 },
      { fontSize: 18, lineHeight: 26 },
    ]);
  });

  it.each([undefined, null, 13, 19, 14.5, "18", Number.NaN])(
    "falls back invalid values to the 14px default: %s",
    (value) => {
      expect(normalizeChatFontSize(value)).toBe(DEFAULT_CHAT_FONT_SIZE);
    },
  );
});
