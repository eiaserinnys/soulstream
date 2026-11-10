import { describe, expect, it, vi } from "vitest";

import {
  ORIGINAL_REQUEST_ITEM_KEY,
  buildOriginalRequestContextItem,
} from "../../src/context/original_request_context.js";

const logger = { warn: vi.fn() };

function source(events: Array<{ event_type: string; payload: unknown }>) {
  return { readEvents: vi.fn(async () => events) };
}

describe("buildOriginalRequestContextItem", () => {
  it("restores the first user message and its context, not the resume prompt", async () => {
    const db = source([
      {
        event_type: "user_message",
        payload: {
          text: "클립 다이제스트를 만들어 주세요",
          context: [
            { key: "clip", label: "클립", content: "원문 본문" },
            { key: ORIGINAL_REQUEST_ITEM_KEY, label: "이전 세대 사본", content: "중복" },
          ],
        },
      },
      { event_type: "user_message", payload: { text: "[Scheduled wakeup]\n\n이어서 진행" } },
    ]);

    const item = await buildOriginalRequestContextItem(db, logger, "s1", "[Scheduled wakeup]");

    expect(db.readEvents).toHaveBeenCalledWith("s1", 0, 20, ["user_message"]);
    expect(item?.key).toBe(ORIGINAL_REQUEST_ITEM_KEY);
    expect(item?.content).toContain("클립 다이제스트를 만들어 주세요");
    expect(item?.content).toContain("원문 본문");
    expect(item?.content).not.toContain("이어서 진행");
    expect(item?.content).not.toContain("중복");
  });

  it("falls back to the stored session prompt when the events cannot be read", async () => {
    const db = { readEvents: vi.fn(async () => { throw new Error("db down"); }) };

    const item = await buildOriginalRequestContextItem(db, logger, "s1", "세션 행의 원래 요청");

    expect(item?.content).toContain("세션 행의 원래 요청");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("returns null when no original request is known", async () => {
    await expect(buildOriginalRequestContextItem(source([]), logger, "s1", null)).resolves.toBeNull();
  });
});
