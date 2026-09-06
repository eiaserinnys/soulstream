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
      expect(toStoredReasoningEffort("low", true)).toBe("low");
      expect(toStoredReasoningEffort("xhigh", true)).toBe("xhigh");
      // A level is a decision regardless of how the contract was described.
      expect(toStoredReasoningEffort("low", false)).toBe("low");
    });

    it("records 'no effort' as the auto marker when the preset had a contract", () => {
      // NULL is reserved for sessions where no decision was made. Writing NULL
      // here would make a new auto session indistinguishable from a legacy one.
      expect(toStoredReasoningEffort(undefined, true)).toBe(REASONING_EFFORT_AUTO);
    });

    it("records nothing when the preset advertised no effort contract", () => {
      // An operator catalogue that predates this feature declares no efforts.
      // Storing `auto` there would claim a decision we never made and would drop
      // Codex from the xhigh it used to get.
      expect(toStoredReasoningEffort(undefined, false)).toBeNull();
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

  describe("catalogue without an effort contract keeps legacy behaviour", () => {
    it("round-trips to the pre-existing backend behaviour", () => {
      // Deploy against an un-updated catalogue: no contract -> NULL -> unrecorded
      // -> Codex replays xhigh, Claude still sends nothing. Exactly as before.
      const stored = toStoredReasoningEffort(undefined, false);
      const read = readStoredReasoningEffort(stored);
      expect(read).toEqual({ recorded: false });
      expect(resolveTurnReasoningEffort(read, "codex")).toBe("xhigh");
      expect(resolveTurnReasoningEffort(read, "claude")).toBeUndefined();
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
