import { describe, expect, it } from "vitest";

import { buildGoogleAuthUrl } from "./Login";

describe("buildGoogleAuthUrl", () => {
  it("uses the main dashboard as the default OAuth return", () => {
    expect(buildGoogleAuthUrl({ pathname: "/", hash: "" })).toBe(
      "/api/auth/google",
    );
  });

  it("returns to the main dashboard and preserves its hash deep link", () => {
    expect(buildGoogleAuthUrl({ pathname: "/", hash: "#/feed/sess-1" })).toBe(
      "/api/auth/google?return_to=%2F%23%2Ffeed%2Fsess-1",
    );
  });

  it("keeps retired routes for the app-level replace redirect", () => {
    expect(buildGoogleAuthUrl({ pathname: "/v3", hash: "" })).toBe(
      "/api/auth/google?return_to=%2Fv3",
    );
  });
});
