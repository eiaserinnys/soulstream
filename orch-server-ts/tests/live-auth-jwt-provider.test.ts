import { describe, expect, it, vi } from "vitest";

import {
  createLiveAuthJwtHelper,
  type LiveConfigProviderBoundary,
} from "../src/index.js";

describe("live auth JWT provider", () => {
  const issuedAt = new Date("2026-01-01T00:00:00.000Z");
  const expectedExp = Math.floor((issuedAt.getTime() + 7 * 24 * 3600 * 1000) / 1000);

  it("issues Python-compatible HS256 dashboard JWT payloads", async () => {
    const configProvider = configWithJwtSecret("jwt-secret");
    const jwt = createLiveAuthJwtHelper({ configProvider, now: () => issuedAt });

    const token = await jwt.issueToken({
      email: "user@example.com",
      name: "User",
      picture: "",
    });

    expect(decodeHeader(token)).toMatchObject({ alg: "HS256", typ: "JWT" });
    expect(decodePayload(token)).toEqual({
      sub: "user@example.com",
      email: "user@example.com",
      name: "User",
      exp: expectedExp,
    });
    await expect(jwt.verifyToken(token)).resolves.toMatchObject({
      sub: "user@example.com",
      email: "user@example.com",
      name: "User",
      exp: expectedExp,
    });
    expect(configProvider.requireConfig).toHaveBeenCalledWith("jwt_secret");
  });

  it("keeps picture only when truthy", async () => {
    const jwt = createLiveAuthJwtHelper({
      configProvider: configWithJwtSecret("jwt-secret"),
      now: () => issuedAt,
    });

    const token = await jwt.issueToken({
      email: "avatar@example.com",
      name: "Avatar",
      picture: "https://example.test/avatar.png",
    });

    expect(decodePayload(token)).toMatchObject({
      picture: "https://example.test/avatar.png",
    });
    await expect(jwt.verifyToken(token)).resolves.toMatchObject({
      picture: "https://example.test/avatar.png",
    });
  });

  it("returns null for malformed, wrong-secret, and expired tokens", async () => {
    const issuer = createLiveAuthJwtHelper({
      configProvider: configWithJwtSecret("jwt-secret"),
      now: () => issuedAt,
      expiresDays: 1,
    });
    const verifier = createLiveAuthJwtHelper({
      configProvider: configWithJwtSecret("jwt-secret"),
      now: () => new Date("2026-01-03T00:00:00.000Z"),
    });
    const wrongSecret = createLiveAuthJwtHelper({
      configProvider: configWithJwtSecret("other-secret"),
      now: () => issuedAt,
    });

    const token = await issuer.issueToken({ email: "user@example.com" });

    await expect(verifier.verifyToken(token)).resolves.toBeNull();
    await expect(wrongSecret.verifyToken(token)).resolves.toBeNull();
    await expect(issuer.verifyToken("not-a-jwt")).resolves.toBeNull();
  });
});

function configWithJwtSecret(secret: string): LiveConfigProviderBoundary {
  return {
    getConfig: vi.fn(async () => ({ jwt_secret: secret })),
    requireConfig: vi.fn(async (key: string) => {
      if (key !== "jwt_secret") throw new Error(`unexpected key ${key}`);
      return secret;
    }),
  };
}

function decodeHeader(token: string): Record<string, unknown> {
  return decodePart(token, 0);
}

function decodePayload(token: string): Record<string, unknown> {
  return decodePart(token, 1);
}

function decodePart(token: string, index: number): Record<string, unknown> {
  const part = token.split(".")[index];
  if (part === undefined) throw new Error(`JWT part ${index} missing`);
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}
