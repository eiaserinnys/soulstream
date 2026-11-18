import { describe, expect, it } from "vitest";

import {
  formatTurnSummarySpeakerLabel,
  parseChildSessionRelationKey,
  resolveTurnSummarySpeaker,
} from "../src/turn-summary/turn_summary_speaker.js";

describe("resolveTurnSummarySpeaker", () => {
  it("labels external callers with the grant label instead of system or user", () => {
    const speaker = resolveTurnSummarySpeaker("user_message", {
      caller_info: { source: "external", display_name: "빌드 봇" },
    });
    expect(speaker).toEqual({ kind: "external", label: "빌드 봇" });
    expect(formatTurnSummarySpeakerLabel(speaker!)).toBe("[발화자: 외부 연동 「빌드 봇」]");
  });

  it("falls back to the external label when the display name is empty", () => {
    const speaker = resolveTurnSummarySpeaker("intervention_sent", {
      caller_info: { source: "external", display_name: " " },
    });
    expect(speaker).toEqual({ kind: "external", label: "외부 연동" });
    expect(formatTurnSummarySpeakerLabel(speaker!)).toBe("[발화자: 외부 연동 「외부 연동」]");
  });
});

describe("parseChildSessionRelationKey", () => {
  it("returns the child id and terminal revision from the shared grammar", () => {
    expect(parseChildSessionRelationKey(
      "child_session:6c958db1-f792-445e-b355-6c5537b0c5c1:1291",
    )).toEqual({
      childSessionId: "6c958db1-f792-445e-b355-6c5537b0c5c1",
      terminalRevision: 1291,
    });
  });

  it.each([
    undefined,
    "",
    "child_session:child-a:not-a-number",
    "child_session:child-a:0",
    "child_session:child-a:1:extra",
  ])("rejects malformed relation key %j", (relationKey) => {
    expect(parseChildSessionRelationKey(relationKey)).toBeUndefined();
  });
});
