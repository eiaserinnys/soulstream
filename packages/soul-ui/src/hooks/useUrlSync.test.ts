import { describe, expect, it } from "vitest";

import { pathWithoutHash } from "./useUrlSync";

describe("pathWithoutHash", () => {
  it("keeps the dashboard pathname when clearing a session hash", () => {
    expect(pathWithoutHash({ pathname: "/v1", search: "" })).toBe("/v1");
    expect(pathWithoutHash({ pathname: "/", search: "" })).toBe("/");
  });

  it("preserves non-hash query parameters", () => {
    expect(pathWithoutHash({ pathname: "/v1", search: "?panel=feed" })).toBe(
      "/v1?panel=feed",
    );
  });
});
