import { describe, expect, it } from "vitest";

import { decideSessionPageEnrollment } from "../../src/page/session_page_enrollment_policy.js";

describe("decideSessionPageEnrollment", () => {
  it.each([
    {
      name: "explicit page wins over a human source",
      input: { hasPageAnchor: true, containerKind: null, callerSource: "browser" },
      expected: { kind: "explicit_page" },
    },
    {
      name: "task container stays on its own board",
      input: { hasPageAnchor: false, containerKind: "task", callerSource: "browser" },
      expected: { kind: "excluded", reason: "task_container" },
    },
    {
      name: "browser speech enrolls in daily",
      input: { hasPageAnchor: false, containerKind: null, callerSource: "browser" },
      expected: { kind: "daily" },
    },
    {
      name: "soul app speech enrolls in daily",
      input: { hasPageAnchor: false, containerKind: null, callerSource: "soul-app" },
      expected: { kind: "daily" },
    },
    {
      name: "a legacy folder container does not suppress human daily enrollment",
      input: { hasPageAnchor: false, containerKind: "folder", callerSource: "browser" },
      expected: { kind: "daily" },
    },
    ...["agent", "system", "api", "llm", "slack", "channel_observer"].map((callerSource) => ({
      name: `${callerSource} automation is excluded`,
      input: { hasPageAnchor: false, containerKind: null, callerSource },
      expected: { kind: "excluded", reason: "non_human_source" },
    })),
    {
      name: "missing source is conservatively excluded",
      input: { hasPageAnchor: false, containerKind: null, callerSource: undefined },
      expected: { kind: "excluded", reason: "non_human_source" },
    },
  ])("$name", ({ input, expected }) => {
    expect(decideSessionPageEnrollment(input)).toEqual(expected);
  });
});
