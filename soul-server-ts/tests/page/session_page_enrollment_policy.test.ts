import { describe, expect, it } from "vitest";

import { decideSessionPageEnrollment } from "../../src/page/session_page_enrollment_policy.js";

describe("decideSessionPageEnrollment", () => {
  it.each([
    {
      name: "explicit page wins over a human source",
      input: { hasPageAnchor: true, callerSource: "browser" },
      expected: { kind: "explicit_page" },
    },
    {
      name: "browser speech enrolls in daily",
      input: { hasPageAnchor: false, callerSource: "browser" },
      expected: { kind: "daily" },
    },
    {
      name: "soul app speech enrolls in daily",
      input: { hasPageAnchor: false, callerSource: "soul-app" },
      expected: { kind: "daily" },
    },
    ...["agent", "system", "api", "llm", "slack", "channel_observer"].map((callerSource) => ({
      name: `${callerSource} automation is excluded`,
      input: { hasPageAnchor: false, callerSource },
      expected: { kind: "excluded", reason: "non_human_source" },
    })),
    {
      name: "missing source is conservatively excluded",
      input: { hasPageAnchor: false, callerSource: undefined },
      expected: { kind: "excluded", reason: "non_human_source" },
    },
  ])("$name", ({ input, expected }) => {
    expect(decideSessionPageEnrollment(input)).toEqual(expected);
  });
});
