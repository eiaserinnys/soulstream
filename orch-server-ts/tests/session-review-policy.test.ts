import { describe, expect, it, vi } from "vitest";

import {
  evaluateInitialSessionReview,
  normalizeSessionReviewSourceAllowlist,
  readSessionReviewPolicy,
  updateSessionReviewPolicy,
} from "../src/system/session_review_policy.js";
import type { SqlClient } from "../src/control_plane/control_plane_types.js";

describe("session review policy", () => {
  it("normalizes source IDs but reserves browser for its qualified invariant", () => {
    expect(normalizeSessionReviewSourceAllowlist([
      " Slack ",
      "external-llm",
      "slack",
      "channel_observer",
    ])).toEqual(["slack", "external-llm", "channel_observer"]);
    expect(() => normalizeSessionReviewSourceAllowlist(["browser"]))
      .toThrow(/identity-qualified/);
    expect(() => normalizeSessionReviewSourceAllowlist(["Bad Source"]))
      .toThrow(/Invalid source/);
  });

  it("always reviews identified browser callers and never anonymous browser callers", () => {
    const policy = { sourceAllowlist: [] };
    for (const callerInfo of [
      { source: "browser", user_id: "user-1" },
      { source: "browser", email: "user@example.com" },
      { source: "browser", display_name: "User" },
    ]) {
      expect(evaluateInitialSessionReview(callerInfo, policy).reviewRequired).toBe(true);
    }
    expect(evaluateInitialSessionReview({
      source: "browser",
      ip: "127.0.0.1",
      user_agent: "test",
    }, policy).reviewRequired).toBe(false);
  });

  it("uses only the stored allowlist for non-browser review classification", () => {
    const policy = { sourceAllowlist: ["external-llm", "clipper"] };
    expect(evaluateInitialSessionReview({ source: "external-llm" }, policy).reviewRequired)
      .toBe(true);
    expect(evaluateInitialSessionReview({ source: "clipper" }, policy).reviewRequired)
      .toBe(true);
    expect(evaluateInitialSessionReview({ source: "llm" }, policy).reviewRequired)
      .toBe(false);
    for (const source of ["agent", "system", "cron", "channel_observer"]) {
      expect(evaluateInitialSessionReview({ source }, policy).reviewRequired)
        .toBe(false);
    }
  });

  it("reads a canonical row with a share lock for registration", async () => {
    const { sql, calls } = fakeSql((text) => text.includes("FROM system_settings")
      ? [policyRow(3, ["slack", "external-llm"])]
      : []);
    await expect(readSessionReviewPolicy(sql, { lock: "share" })).resolves.toMatchObject({
      sourceAllowlist: ["slack", "external-llm"],
      version: 3,
    });
    expect(calls[0]).toContain("FOR SHARE");
  });

  it("fails visibly for a missing or corrupt policy", async () => {
    const missing = fakeSql(() => []).sql;
    await expect(readSessionReviewPolicy(missing)).rejects.toMatchObject({
      code: "SESSION_REVIEW_POLICY_UNAVAILABLE",
      statusCode: 503,
    });

    const corrupt = fakeSql(() => [{
      ...policyRow(1, ["slack"]),
      value: { source_allowlist: ["browser"] },
    }]).sql;
    await expect(readSessionReviewPolicy(corrupt)).rejects.toMatchObject({
      code: "SESSION_REVIEW_POLICY_UNAVAILABLE",
      statusCode: 503,
    });
  });

  it("updates with CAS and reports a stale writer conflict", async () => {
    let version = 4;
    const { sql } = fakeSql((text, values) => {
      if (text.includes("UPDATE system_settings")) {
        const expected = Number(values.at(-1));
        if (expected !== version) return [];
        version += 1;
        return [policyRow(version, (values[0] as { source_allowlist: string[] }).source_allowlist)];
      }
      if (text.includes("FROM system_settings")) return [policyRow(version, ["slack"] )];
      return [];
    });

    await expect(updateSessionReviewPolicy(sql, {
      sourceAllowlist: ["clipper"],
      expectedVersion: 4,
      updatedBy: "admin@example.com",
    })).resolves.toMatchObject({ version: 5, sourceAllowlist: ["clipper"] });
    await expect(updateSessionReviewPolicy(sql, {
      sourceAllowlist: ["slack"],
      expectedVersion: 4,
      updatedBy: "admin@example.com",
    })).rejects.toMatchObject({
      code: "SESSION_REVIEW_POLICY_CONFLICT",
      statusCode: 409,
    });
  });
});

function policyRow(version: number, sourceAllowlist: string[]) {
  return {
    setting_key: "session_review_policy",
    value: { source_allowlist: sourceAllowlist },
    version,
    updated_at: new Date("2026-09-14T00:00:00.000Z"),
    updated_by: "admin@example.com",
  };
}

function fakeSql(
  execute: (text: string, values: unknown[]) => readonly Record<string, unknown>[],
): { sql: SqlClient; calls: string[] } {
  const calls: string[] = [];
  const query = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push(text);
    return execute(text, values);
  }) as unknown as SqlClient;
  const extended = query as unknown as { json(value: unknown): unknown };
  extended.json = vi.fn((value) => value);
  return { sql: query, calls };
}
