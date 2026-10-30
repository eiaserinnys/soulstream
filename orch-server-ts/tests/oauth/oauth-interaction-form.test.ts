import { describe, expect, it } from "vitest";
import { parseOAuthInteractionFormBody } from "../../src/oauth/oauth_routes.js";

describe("OAuth interaction form parsing", () => {
  it("reads URL-encoded consent values whether Fastify supplies a string, Buffer, or object", () => {
    const body = "csrf=csrf-token&action=allow";
    expect(parseOAuthInteractionFormBody(body)).toEqual({ csrf: "csrf-token", action: "allow" });
    expect(parseOAuthInteractionFormBody(Buffer.from(body))).toEqual({ csrf: "csrf-token", action: "allow" });
    expect(parseOAuthInteractionFormBody({ csrf: "csrf-token", action: "allow" })).toEqual({ csrf: "csrf-token", action: "allow" });
  });
});
