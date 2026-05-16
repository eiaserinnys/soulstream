import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { parseEnv } from "../src/config.js";

describe("parseEnv", () => {
  const minimal = {
    SOULSTREAM_NODE_ID: "eias-shopping-ts",
    SOULSTREAM_UPSTREAM_URL: "ws://localhost:5200/ws/node",
  };

  it("필수 키만 있으면 default들이 채워진다", () => {
    const env = parseEnv(minimal);
    expect(env.SOULSTREAM_NODE_ID).toBe("eias-shopping-ts");
    expect(env.AUTH_BEARER_TOKEN).toBe("");
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.PORT).toBe(4205);
    expect(env.ENVIRONMENT).toBe("development");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.DASH_USER_NAME).toBe("");
  });

  it("SOULSTREAM_NODE_ID 부재 시 ZodError", () => {
    expect(() =>
      parseEnv({ SOULSTREAM_UPSTREAM_URL: "ws://localhost:5200/ws/node" }),
    ).toThrow(ZodError);
  });

  it("SOULSTREAM_UPSTREAM_URL 부재 시 ZodError", () => {
    expect(() => parseEnv({ SOULSTREAM_NODE_ID: "x" })).toThrow(ZodError);
  });

  it("SOULSTREAM_UPSTREAM_URL이 ws:// 또는 wss://가 아니면 거부", () => {
    expect(() =>
      parseEnv({ ...minimal, SOULSTREAM_UPSTREAM_URL: "http://localhost:5200/ws/node" }),
    ).toThrow(ZodError);
  });

  it("wss://는 허용", () => {
    const env = parseEnv({ ...minimal, SOULSTREAM_UPSTREAM_URL: "wss://example.com/ws/node" });
    expect(env.SOULSTREAM_UPSTREAM_URL).toBe("wss://example.com/ws/node");
  });

  it("PORT 문자열 → 숫자 coerce", () => {
    const env = parseEnv({ ...minimal, PORT: "4205" });
    expect(env.PORT).toBe(4205);
  });

  it("production이면서 AUTH_BEARER_TOKEN 부재 → ZodError", () => {
    expect(() =>
      parseEnv({
        ...minimal,
        ENVIRONMENT: "production",
        AUTH_BEARER_TOKEN: "",
      }),
    ).toThrow(ZodError);
  });

  it("production + AUTH_BEARER_TOKEN 있음 → 통과", () => {
    const env = parseEnv({
      ...minimal,
      ENVIRONMENT: "production",
      AUTH_BEARER_TOKEN: "secret",
    });
    expect(env.AUTH_BEARER_TOKEN).toBe("secret");
    expect(env.ENVIRONMENT).toBe("production");
  });

  it("LOG_LEVEL이 enum 범위 외면 거부", () => {
    expect(() => parseEnv({ ...minimal, LOG_LEVEL: "verbose" })).toThrow(ZodError);
  });
});
