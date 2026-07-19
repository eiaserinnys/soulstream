import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_CHAT_FONT_SIZE } from "../../lib/chat-typography";
import { useDashboardStore } from "../dashboard-store";

describe("chat typography dashboard slice", () => {
  beforeEach(() => {
    useDashboardStore.setState({ chatFontSize: DEFAULT_CHAT_FONT_SIZE });
  });

  it("updates valid discrete values immediately", () => {
    useDashboardStore.getState().setChatFontSize(18);

    expect(useDashboardStore.getState().chatFontSize).toBe(18);
  });

  it("normalizes invalid values back to the default", () => {
    useDashboardStore.getState().setChatFontSize(19);

    expect(useDashboardStore.getState().chatFontSize).toBe(14);
  });
});
