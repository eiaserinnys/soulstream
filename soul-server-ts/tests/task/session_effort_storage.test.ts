import { describe, expect, it } from "vitest";

import {
  REASONING_EFFORT_AUTO,
  normalizePublicReasoningEffort,
  readStoredReasoningEffort,
  resolveTurnReasoningEffort,
  toStoredReasoningEffort,
} from "../../src/task/session_effort_storage.js";

/**
 * The compatibility boundary. Three resume cases must stay distinguishable, and
 * the only thing separating the first two in the database is NULL vs `auto`.
 */
describe("session effort storage boundary", () => {
  describe("write", () => {
    it("stores a resolved level verbatim", () => {
      expect(toStoredReasoningEffort("low")).toBe("low");
      expect(toStoredReasoningEffort("xhigh")).toBe("xhigh");
    });

    it("records 'no effort' as the auto marker", () => {
      // NULL is reserved for rows that carry no decision at all. Writing NULL
      // here would make a new auto session indistinguishable from a legacy one,
      // and would hand it the legacy Codex xhigh on the next turn.
      expect(toStoredReasoningEffort(undefined)).toBe(REASONING_EFFORT_AUTO);
    });
  });

  describe("read", () => {
    it("marks a pre-089 NULL as unrecorded", () => {
      expect(readStoredReasoningEffort(null)).toEqual({ recorded: false });
      expect(readStoredReasoningEffort(undefined)).toEqual({ recorded: false });
    });

    it("marks the auto marker as recorded with no level", () => {
      expect(readStoredReasoningEffort(REASONING_EFFORT_AUTO)).toEqual({
        recorded: true,
      });
    });

    it("reads a recorded level back", () => {
      expect(readStoredReasoningEffort("low")).toEqual({
        recorded: true,
        effort: "low",
      });
      expect(readStoredReasoningEffort("minimal")).toEqual({
        recorded: true,
        effort: "minimal",
      });
    });

    it("does not replay an unreadable value", () => {
      expect(readStoredReasoningEffort("banana")).toEqual({ recorded: true });
    });
  });

  describe("a session created by this build always carries a decision", () => {
    it("never round-trips to the unrecorded state", () => {
      // Whatever the catalogue says, creating a session is itself the decision.
      // Landing in `recorded: false` here would hand a brand new session the
      // legacy Codex xhigh instead of the backend default.
      for (const resolved of [undefined, "low"] as const) {
        const read = readStoredReasoningEffort(toStoredReasoningEffort(resolved));
        expect(read.recorded).toBe(true);
        expect(resolveTurnReasoningEffort(read, "codex")).toBe(resolved);
      }
    });
  });

  describe("the three resume cases", () => {
    it("1. untouched pre-089 session replays the old Codex behaviour only for Codex", () => {
      const legacy = readStoredReasoningEffort(null);
      expect(resolveTurnReasoningEffort(legacy, "codex")).toBe("xhigh");
      // Claude ignored effort entirely before this change, so it must keep
      // getting nothing — restoring xhigh there would change existing sessions.
      expect(resolveTurnReasoningEffort(legacy, "claude")).toBeUndefined();
      expect(resolveTurnReasoningEffort(legacy, undefined)).toBeUndefined();
    });

    it("2. new auto session sends nothing on every backend", () => {
      const auto = readStoredReasoningEffort(REASONING_EFFORT_AUTO);
      expect(resolveTurnReasoningEffort(auto, "codex")).toBeUndefined();
      expect(resolveTurnReasoningEffort(auto, "claude")).toBeUndefined();
    });

    it("3. new explicit level is used as-is on every backend", () => {
      const low = readStoredReasoningEffort("low");
      expect(resolveTurnReasoningEffort(low, "codex")).toBe("low");
      expect(resolveTurnReasoningEffort(low, "claude")).toBe("low");
    });

    it("keeps the three cases mutually distinguishable for Codex", () => {
      const codex = (stored: string | null) =>
        resolveTurnReasoningEffort(readStoredReasoningEffort(stored), "codex");
      expect(codex(null)).toBe("xhigh");
      expect(codex(REASONING_EFFORT_AUTO)).toBeUndefined();
      expect(codex("low")).toBe("low");
    });
  });

  describe("public projection", () => {
    it("never leaks the auto marker", () => {
      expect(normalizePublicReasoningEffort(REASONING_EFFORT_AUTO)).toBeNull();
      expect(normalizePublicReasoningEffort(null)).toBeNull();
      expect(normalizePublicReasoningEffort("low")).toBe("low");
    });
  });
});
