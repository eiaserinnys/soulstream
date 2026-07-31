import { describe, expect, it } from "vitest";

import { parseChildSessionRelationKey } from
  "../src/turn-summary/turn_summary_speaker.js";

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
