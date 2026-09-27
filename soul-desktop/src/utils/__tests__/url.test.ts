import { describe, expect, it } from "vitest";
import { normalizeUrl } from "../url";

describe("normalizeUrl", () => {
  it("preserves an explicitly entered HTTP scheme", () => {
    expect(normalizeUrl("http://localhost:1420/path")).toBe(
      "http://localhost:1420/path",
    );
  });

  it("adds HTTPS when the input has no scheme", () => {
    expect(normalizeUrl("soul.example.me")).toBe("https://soul.example.me");
  });
});
