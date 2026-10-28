import { describe, expect, it } from "vitest";

import {
  getProviderLimitRejection,
  observeProviderExecution,
  type ProviderExecutionEvent,
  type ProviderLimitRejection,
} from "../src/usage/provider_limit_rejection.js";

const groups = [
  { provider: "codex", nodeIds: ["node-b", "node-a"] },
  { provider: "claude", nodeIds: ["node-a", "node-c"] },
];
const now = new Date("2026-10-12T03:00:00.000Z");
const reset = "2026-10-12T04:00:00.000Z";
const rejections = new Map<string, ProviderLimitRejection>();

describe("provider limit rejection memory", () => {
  it("records durable error codes under the authenticated provider account", () => {
    const memory = new Map(rejections);
    observe(memory, {
      nodeId: "node-a",
      eventType: "error",
      payload: {
        type: "error",
        error_code: "codex_usage_limit_exceeded",
        rate_limit_type: "seven_day_primary",
        resets_at: reset,
      },
      createdAt: "2026-10-12T02:59:00.000Z",
    });

    expect(get(memory, "node-b", "codex")).toEqual({
      rejectedUntil: reset,
      rateLimitType: "seven_day_primary",
      observedAt: "2026-10-12T02:59:00.000Z",
    });
    expect(get(memory, "node-a", "claude")).toBeNull();
  });

  it.each([
    ["credential alert", "credential_alert", "claude_rate_limit_stop_failure"],
    ["wrong code", "error", "some_other_error"],
    ["missing reset", "error", "claude_rate_limit_stop_failure"],
  ])("ignores %s as a rejection", (_label, eventType, errorCode) => {
    const memory = new Map(rejections);
    observe(memory, {
      nodeId: "node-c",
      eventType,
      payload: {
        type: eventType,
        error_code: errorCode,
        ...(errorCode === "some_other_error" ? { resets_at: reset } : {}),
      },
      createdAt: now.toISOString(),
    });
    expect(get(memory, "node-c", "claude")).toBeNull();
  });

  it.each(["invalid", "past"] as const)("ignores a %s reset without overwriting a live rejection", resetKind => {
    const memory = new Map(rejections);
    const existing = { rejectedUntil: reset, rateLimitType: "five_hour", observedAt: "2026-10-12T02:00:00.000Z" };
    observe(memory, errorEvent("node-a", "claude_rate_limit_stop_failure", existing));
    observe(memory, {
      nodeId: "node-a",
      eventType: "error",
      payload: {
        type: "error",
        error_code: "claude_rate_limit_stop_failure",
        resets_at: resetKind === "invalid" ? "not-a-date" : "2026-10-12T02:59:59.999Z",
      },
      createdAt: "2026-10-12T02:30:00.000Z",
    });

    expect(get(memory, "node-c", "claude")).toEqual(existing);
  });

  it("keeps only the latest observed rejection and clears only on a later provider success", () => {
    const memory = new Map(rejections);
    observe(memory, errorEvent("node-a", "codex_usage_limit_exceeded", {
      rejectedUntil: reset,
      rateLimitType: "five_hour",
      observedAt: "2026-10-12T02:00:00.000Z",
    }));
    observe(memory, errorEvent("node-b", "codex_usage_limit_exceeded", {
      rejectedUntil: "2026-10-12T05:00:00.000Z",
      rateLimitType: "seven_day",
      observedAt: "2026-10-12T01:59:00.000Z",
    }));
    expect(get(memory, "node-a", "codex")?.observedAt).toBe("2026-10-12T02:00:00.000Z");

    observe(memory, successEvent("node-a", "complete", {
      type: "complete",
      raw_event_type: "turn/completed",
      status: "completed",
    }, "2026-10-12T02:00:00.000Z"));
    expect(get(memory, "node-a", "codex")).not.toBeNull();

    observe(memory, successEvent("node-a", "complete", {
      type: "complete",
      raw_event_type: "turn/completed",
      status: "completed",
    }, "2026-10-12T02:01:00.000Z"));
    expect(get(memory, "node-b", "codex")).toBeNull();
  });

  it("does not restore an expired rejection from an older committed event", () => {
    const memory = new Map(rejections);
    observeProviderExecution({
      memory,
      sharedAccountGroups: groups,
      event: errorEvent("node-a", "codex_usage_limit_exceeded", {
        rejectedUntil: "2026-10-12T03:00:00.000Z",
        rateLimitType: "five_hour",
        observedAt: "2026-10-12T02:59:00.000Z",
      }),
      now: new Date("2026-10-12T02:59:30.000Z"),
    });
    observe(memory, errorEvent("node-a", "codex_usage_limit_exceeded", {
      rejectedUntil: reset,
      rateLimitType: "seven_day",
      observedAt: "2026-10-12T02:58:00.000Z",
    }));

    expect(get(memory, "node-a", "codex")).toBeNull();
  });

  it("does not treat generic Codex complete or unsuccessful Claude result as success", () => {
    const memory = new Map(rejections);
    observe(memory, errorEvent("node-a", "codex_usage_limit_exceeded", {
      rejectedUntil: reset,
      rateLimitType: null,
      observedAt: "2026-10-12T02:00:00.000Z",
    }));
    observe(memory, errorEvent("node-a", "claude_rate_limit_stop_failure", {
      rejectedUntil: reset,
      rateLimitType: null,
      observedAt: "2026-10-12T02:00:00.000Z",
    }));
    observe(memory, successEvent("node-a", "complete", { type: "complete" }, "2026-10-12T02:01:00.000Z"));
    expect(get(memory, "node-a", "codex")).not.toBeNull();
    observe(memory, successEvent("node-a", "result", { type: "result", success: false }, "2026-10-12T02:02:00.000Z"));
    expect(get(memory, "node-c", "claude")).not.toBeNull();

    observe(memory, successEvent("node-a", "result", { type: "result", success: true }, "2026-10-12T02:03:00.000Z"));
    expect(get(memory, "node-c", "claude")).toBeNull();
  });

  it("treats reset equality as expired without requiring a timer", () => {
    const memory = new Map(rejections);
    observe(memory, errorEvent("node-a", "codex_usage_limit_exceeded", {
      rejectedUntil: reset,
      rateLimitType: null,
      observedAt: now.toISOString(),
    }));

    expect(read(memory, "node-a", "codex", new Date(reset))).toBeNull();
    expect(memory.size).toBe(1);
  });
});

describe("Claude account-pool rejection memory", () => {
  it("keys rejection by UUID and scope without letting another account success clear it", () => {
    const memory = new Map<string, ProviderLimitRejection>();
    observePool(memory, {
      nodeId: "node-a",
      eventType: "error",
      payload: {
        type: "error",
        error_code: "claude_rate_limit_stop_failure",
        account_id: "account-a",
        scope: "all",
        rate_limit_type: "five_hour",
        resets_at: "2026-10-12T04:00:00.000Z",
      },
      createdAt: "2026-10-12T02:59:00.000Z",
    });
    observePool(memory, {
      nodeId: "node-b",
      eventType: "result",
      payload: { type: "result", success: true, account_id: "account-b", scope: "all" },
      createdAt: "2026-10-12T03:01:00.000Z",
    });

    expect(getPool(memory, "node-b", "account-a", "all")).toMatchObject({
      rejectedUntil: "2026-10-12T04:00:00.000Z",
      rateLimitType: "five_hour",
    });
    expect(getPool(memory, "node-a", "account-b", "all")).toBeNull();
  });

  it("keeps the maximum reset for an account and represents indefinite blocks", () => {
    const memory = new Map<string, ProviderLimitRejection>();
    observePool(memory, poolError("account-a", "all", "five_hour", "2026-10-12T04:00:00.000Z"));
    observePool(memory, poolError("account-a", "all", "seven_day", "2026-10-12T05:00:00.000Z"));
    observePool(memory, poolError("account-b", "fable", "weekly_scoped", null));

    expect(getPool(memory, "node-a", "account-a", "all")?.rejectedUntil)
      .toBe("2026-10-12T05:00:00.000Z");
    expect(getPool(memory, "node-a", "account-b", "fable")).toMatchObject({ rejectedUntil: null });
    expect(getPool(memory, "node-a", "account-b", "all")).toBeNull();
  });
});

function observe(memory: Map<string, ProviderLimitRejection>, event: ProviderExecutionEvent): void {
  observeProviderExecution({
    memory,
    sharedAccountGroups: groups,
    event,
    now,
  });
}

function get(memory: Map<string, ProviderLimitRejection>, nodeId: string, provider: "claude" | "codex") {
  return read(memory, nodeId, provider, now);
}

function read(memory: Map<string, ProviderLimitRejection>, nodeId: string, provider: "claude" | "codex", at: Date) {
  return getProviderLimitRejection({ memory, sharedAccountGroups: groups, nodeId, provider, now: at });
}

function errorEvent(nodeId: string, errorCode: string, rejection: ProviderLimitRejection): ProviderExecutionEvent {
  return {
    nodeId,
    eventType: "error",
    payload: {
      type: "error",
      error_code: errorCode,
      rate_limit_type: rejection.rateLimitType,
      resets_at: rejection.rejectedUntil,
    },
    createdAt: rejection.observedAt,
  };
}

function successEvent(nodeId: string, eventType: string, payload: unknown, createdAt: string): ProviderExecutionEvent {
  return { nodeId, eventType, payload, createdAt };
}

function observePool(memory: Map<string, ProviderLimitRejection>, event: ProviderExecutionEvent): void {
  observeProviderExecution({ memory, sharedAccountGroups: groups, event, now, poolNode: true });
}

function getPool(
  memory: ReadonlyMap<string, ProviderLimitRejection>,
  nodeId: string,
  accountId: string,
  scope: "all" | "fable",
) {
  return getProviderLimitRejection({
    memory,
    sharedAccountGroups: groups,
    nodeId,
    provider: "claude",
    accountId,
    scope,
    poolNode: true,
    now,
  });
}

function poolError(
  accountId: string,
  scope: "all" | "fable",
  rateLimitType: string,
  resetsAt: string | null,
): ProviderExecutionEvent {
  return {
    nodeId: "node-a",
    eventType: "error",
    payload: {
      type: "error",
      error_code: "claude_rate_limit_stop_failure",
      account_id: accountId,
      scope,
      rate_limit_type: rateLimitType,
      resets_at: resetsAt,
    },
    createdAt: "2026-10-12T02:59:00.000Z",
  };
}
