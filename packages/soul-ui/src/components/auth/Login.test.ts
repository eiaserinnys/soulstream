import { describe, expect, it } from "vitest";

import { buildGoogleAuthUrl } from "./Login";

describe("buildGoogleAuthUrl", () => {
  it("uses the main dashboard as the default OAuth return", () => {
    expect(buildGoogleAuthUrl({ pathname: "/", hash: "" })).toBe(
      "/api/auth/google",
    );
  });

  it("returns to v1 and preserves its hash deep link", () => {
    expect(buildGoogleAuthUrl({ pathname: "/v1", hash: "#/feed/sess-1" })).toBe(
      "/api/auth/google?return_to=%2Fv1%23%2Ffeed%2Fsess-1",
    );
  });

  it("keeps retired routes for the app-level replace redirect", () => {
    expect(buildGoogleAuthUrl({ pathname: "/v3", hash: "" })).toBe(
      "/api/auth/google?return_to=%2Fv3",
    );
  });
});
