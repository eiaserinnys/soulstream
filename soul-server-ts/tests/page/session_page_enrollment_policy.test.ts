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
      name: "browser source is excluded",
      input: { hasPageAnchor: false, callerSource: "browser" },
      expected: { kind: "excluded", reason: "non_human_source" },
    },
    {
      name: "soul app source is excluded",
      input: { hasPageAnchor: false, callerSource: "soul-app" },
      expected: { kind: "excluded", reason: "non_human_source" },
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
