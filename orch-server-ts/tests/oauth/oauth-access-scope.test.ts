import { describe, expect, it } from "vitest";
import type { SqlClient } from "../../src/control_plane/control_plane_types.js";
import {
  createOAuthAccessTokenResolver,
  oauthScopeForRoute,
  persistOAuthProfile,
  requireOAuthScope,
  type OAuthResourceAccess,
} from "../../src/oauth/oauth_access.js";

const access: OAuthResourceAccess = {
  email: "director@example.test",
  displayName: "Director",
  avatarUrl: "https://example.test/director.png",
  clientId: "client-1",
  clientName: "Kaleidoscope",
  scopes: ["cards:read", "folders:read"],
};

describe("OAuth resource scopes", () => {
  it("requires the matching read scope for card and folder GET routes", () => {
    expect(oauthScopeForRoute("GET", "/api/cards")).toBe("cards:read");
    expect(oauthScopeForRoute("GET", "/api/cards/card-1")).toBe("cards:read");
    expect(oauthScopeForRoute("GET", "/api/folders")).toBe("folders:read");
    expect(oauthScopeForRoute("GET", "/api/folders/folder-1")).toBe("folders:read");
  });

  it("keeps every other method and resource outside the OAuth allowlist", () => {
    expect(oauthScopeForRoute("POST", "/api/cards")).toBeNull();
    expect(oauthScopeForRoute("GET", "/api/sessions")).toBeNull();
    expect(oauthScopeForRoute("POST", "/api/sessions")).toBeNull();
  });

  it("checks a resolved token for the requested scope", () => {
    expect(requireOAuthScope(access, "cards:read")).toEqual({ ok: true });
    expect(requireOAuthScope(access, "folders:read")).toEqual({ ok: true });
    expect(requireOAuthScope(access, "conversations")).toEqual({
      ok: false,
      statusCode: 403,
      detail: "Insufficient OAuth scope",
    });
    expect(requireOAuthScope(null, "conversations")).toMatchObject({ ok: false });
  });

  it("uses the verified Google profile for OAuth caller identity", async () => {
    const entities = new Map<string, Record<string, unknown>>();
    const sql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join("?");
      if (statement.includes("INSERT INTO oauth_entities")) {
        entities.set(`${String(values[0])}:${String(values[1])}`, values[2] as Record<string, unknown>);
        return [];
      }
      if (statement.includes("SELECT payload, consumed_at FROM oauth_entities")) {
        const payload = entities.get(`${String(values[0])}:${String(values[1])}`);
        return payload === undefined ? [] : [{ payload, consumed_at: null }];
      }
      return [];
    }, { json: (value: unknown) => value }) as unknown as SqlClient;
    entities.set("AccessToken:opaque-token", {
      accountId: "director@example.test",
      clientId: "client-1",
      scope: "cards:read folders:read",
    });
    entities.set("Client:client-1", { client_name: "Kaleidoscope" });

    await persistOAuthProfile(sql, {
      email: "Director@Example.Test",
      name: "Director",
      picture: "https://example.test/director.png",
    });
    const resolve = createOAuthAccessTokenResolver(sql, async () => null);

    await expect(resolve("opaque-token")).resolves.toMatchObject({
      email: "director@example.test",
      displayName: "Director",
      avatarUrl: "https://example.test/director.png",
    });
  });
});
