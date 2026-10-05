import { describe, expect, it } from "vitest";

import {
  CODEX_USAGE_LIMIT_ERROR_CODE,
} from "../../../src/engine/usage_limit_stop.js";
import {
  buildUsageLimitStopEvents,
  isUsageLimitTurnError,
  selectUsageLimitReset,
} from "../../../src/engine/codex_app_server/usage_limit.js";
import type { SSEEventPayload } from "../../../src/engine/protocol.js";

describe("Codex app-server usage-limit helpers", () => {
  it("recognizes only the usageLimitExceeded error variant", () => {
    expect(isUsageLimitTurnError({ codexErrorInfo: "usageLimitExceeded" })).toBe(true);
    expect(isUsageLimitTurnError({ codexErrorInfo: "serverOverloaded" })).toBe(false);
    expect(isUsageLimitTurnError({
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } },
    })).toBe(false);
    expect(isUsageLimitTurnError(null)).toBe(false);
  });

  it("returns no stop metadata for a rate-limit read below exhaustion", () => {
    // This snapshot follows the 55% account/rateLimits/read shape measured during design.
    expect(selectUsageLimitReset({
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 55,
          windowDurationMins: 300,
          resetsAt: 1790411030,
        },
        secondary: null,
      },
    }, 1790042511)).toEqual({});
  });

  it("selects the latest exhausted window across rateLimitsByLimitId", () => {
    const response = {
      rateLimits: {
        limitId: "premium",
        primary: null,
        secondary: null,
      },
      rateLimitsByLimitId: {
        premium: {
          limitId: "premium",
          primary: null,
          secondary: null,
        },
        codex: {
          limitId: "codex",
          primary: {
            usedPercent: 100,
            windowDurationMins: 300,
            resetsAt: 1790100000,
          },
          secondary: {
            usedPercent: 100,
            windowDurationMins: 10080,
            resetsAt: 1790411030,
          },
        },
      },
    };

    expect(selectUsageLimitReset(response, 1790042511)).toEqual({
      rateLimitType: "seven_day",
      resetsAt: "2026-09-26T08:23:50.000Z",
    });
  });

  it("falls back to rateLimits and omits an unknown window label", () => {
    expect(selectUsageLimitReset({
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 100,
          windowDurationMins: 60,
          resetsAt: 1790100000,
        },
        secondary: null,
      },
    }, 1790042511)).toEqual({
      resetsAt: "2026-09-22T18:00:00.000Z",
    });
  });

  it("builds the rejected credential alert before the fatal error without copying a message", () => {
    const errorPayload = {
      type: "error",
      message: "You've hit your usage limit.",
      fatal: true,
      will_retry: false,
      error_code: CODEX_USAGE_LIMIT_ERROR_CODE,
      error_info: "usageLimitExceeded",
      additional_details: null,
      timestamp: 1790042511.846,
      raw_event_type: "error",
      thread_id: "01a0c607-e635-71d1-905a-f0aac395a1ec",
      turn_id: "01a0c6d7-a8bd-7971-9376-a32a110b3bb3",
    } as SSEEventPayload;

    const events = buildUsageLimitStopEvents(errorPayload, {
      rateLimitType: "seven_day",
      resetsAt: "2026-09-26T08:23:50.000Z",
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "credential_alert",
      status: "rejected",
      rate_limit_type: "seven_day",
      resets_at: "2026-09-26T08:23:50.000Z",
      timestamp: 1790042511.846,
      raw_event_type: "error",
      thread_id: "01a0c607-e635-71d1-905a-f0aac395a1ec",
      turn_id: "01a0c6d7-a8bd-7971-9376-a32a110b3bb3",
    });
    expect(events[0]).not.toHaveProperty("message");
    expect(events[1]).toMatchObject({
      ...errorPayload,
      rate_limit_type: "seven_day",
      resets_at: "2026-09-26T08:23:50.000Z",
    });
  });
});
