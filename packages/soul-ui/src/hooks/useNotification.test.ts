import { describe, expect, it } from "vitest";

import type { ErrorEvent } from "../shared/types";
import { formatNotification } from "./useNotification";

describe("formatNotification", () => {
  it("reports retryable error as reconnect history", () => {
    const event: ErrorEvent = {
      type: "error",
      message: "Reconnecting... 2/2",
      fatal: false,
      will_retry: true,
    };

    expect(formatNotification(event)).toEqual({
      title: "⚠️ 자동 재연결 발생",
      body: "응답 연결이 끊겨 같은 작업에 자동 재연결이 발생했습니다. Reconnecting... 2/2",
    });
  });

  it.each([
    ["false", false],
    ["missing", undefined],
  ])("keeps %s retry flag error notification unchanged", (_label, willRetry) => {
    const event: ErrorEvent = {
      type: "error",
      message: "Something went wrong",
      ...(willRetry === undefined ? {} : { will_retry: willRetry }),
    };

    expect(formatNotification(event)).toEqual({
      title: "❌ Session Error",
      body: "Something went wrong",
    });
  });
});
