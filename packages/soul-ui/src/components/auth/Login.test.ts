import { describe, expect, it } from "vitest";

import { buildGoogleAuthUrl } from "./Login";

describe("buildGoogleAuthUrl", () => {
  it("uses the main dashboard as the default OAuth return", () => {
    expect(buildGoogleAuthUrl({ pathname: "/", search: "", hash: "" })).toBe(
      "/api/auth/google",
    );
  });

  it("returns to the main dashboard and preserves its hash deep link", () => {
    expect(buildGoogleAuthUrl({ pathname: "/", search: "", hash: "#/feed/sess-1" })).toBe(
      "/api/auth/google?return_to=%2F%23%2Ffeed%2Fsess-1",
    );
  });

  it("preserves encoded root session and optional event queries through OAuth", () => {
    expect(buildGoogleAuthUrl({
      pathname: "/",
      search: "?session=session%2Fwith%20space&event=42",
      hash: "",
    })).toBe(
      "/api/auth/google?return_to=%2F%3Fsession%3Dsession%252Fwith%2520space%26event%3D42",
    );
    expect(buildGoogleAuthUrl({ pathname: "/", search: "?session=sess-1", hash: "" })).toBe(
      "/api/auth/google?return_to=%2F%3Fsession%3Dsess-1",
    );
  });

  it("keeps retired routes for the app-level replace redirect", () => {
    expect(buildGoogleAuthUrl({ pathname: "/v3", search: "", hash: "" })).toBe(
      "/api/auth/google?return_to=%2Fv3",
    );
  });
});
