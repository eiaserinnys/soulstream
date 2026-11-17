import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ResolvedMcpServer } from "../src/mcp_config_service.js";
import {
  collectEnvSecretValues,
  collectMcpServerSecretValues,
  maskSecrets,
  registerSecretValueSource,
  resetSecretMaskerForTests,
} from "../src/secret_masker.js";

function registerSecret(value: string, name = "test:value"): void {
  registerSecretValueSource("test", () => [{ name, value }]);
}

describe("collectMcpServerSecretValues", () => {
  it("collects sensitive headers, the bearer token alone, stdio env, and URL query values", () => {
    const servers: ResolvedMcpServer[] = [
      {
        type: "streamable_http",
        name: "arbor",
        url: "https://mcp.example.test/mcp?exaApiKey=test-secret-query-value&tools=web_search",
        headers: {
          Authorization: "Bearer test-secret-bearer-token",
          "X-Trace-Id": "trace-not-a-secret",
        },
      },
      {
        type: "stdio",
        name: "docs",
        command: "node",
        args: ["server.js", "--endpoint=https://docs.example.test/mcp?apiKey=test-secret-arg-query"],
        env: {
          API_TOKEN: "test-secret-stdio-env",
          LOG_LEVEL: "info",
        },
      },
    ];

    const values = collectMcpServerSecretValues(servers);
    const plainValues = values.map((entry) => entry.value);

    expect(plainValues).toContain("Bearer test-secret-bearer-token");
    expect(plainValues).toContain("test-secret-bearer-token");
    expect(plainValues).toContain("test-secret-stdio-env");
    expect(plainValues).toContain("test-secret-query-value");
    expect(plainValues).toContain("test-secret-arg-query");
    expect(plainValues).not.toContain("trace-not-a-secret");
    expect(plainValues).not.toContain("info");
    expect(
      values.find((entry) => entry.value === "test-secret-bearer-token")?.name,
    ).toBe("mcp:arbor:headers:Authorization");
    expect(
      values.find((entry) => entry.value === "test-secret-stdio-env")?.name,
    ).toBe("mcp:docs:env:API_TOKEN");
  });

  it("keeps both the decoded and the encoded URL query value", () => {
    const values = collectMcpServerSecretValues([
      {
        type: "streamable_http",
        name: "encoded",
        url: "https://mcp.example.test/mcp?access_token=test%2Dsecret%2Dencoded",
      },
    ]);
    const plainValues = values.map((entry) => entry.value);

    expect(plainValues).toContain("test-secret-encoded");
    expect(plainValues).toContain("test%2Dsecret%2Dencoded");
  });

  it("drops values shorter than eight characters and any non-sensitive header", () => {
    const values = collectMcpServerSecretValues([
      {
        type: "streamable_http",
        name: "short",
        url: "https://mcp.example.test/mcp?apiKey=test-se",
        headers: {
          "X-API-KEY": "short-7",
          "X-Trace-Id": "trace-not-a-secret",
        },
      },
    ]);

    expect(values).toEqual([]);
  });

  it("dedupes the same value collected from different sensitive keys", () => {
    const values = collectMcpServerSecretValues([
      {
        type: "streamable_http",
        name: "duplicate",
        url: "https://mcp.example.test/mcp",
        headers: {
          Authorization: "Bearer test-secret-duplicate-value",
          "X-API-Key": "test-secret-duplicate-value",
        },
      },
    ]);

    expect(values.filter((entry) => entry.value === "test-secret-duplicate-value"))
      .toHaveLength(1);
  });
});

describe("collectEnvSecretValues", () => {
  it("collects sensitive environment values and skips paths, booleans, and numbers", () => {
    const values = collectEnvSecretValues({
      OPENAI_API_KEY: "test-secret-openai",
      AUTH_TOKEN: "test-secret-auth-token",
      AUTH_TOKEN_PATH: "/run/secrets/test-secret-auth-token",
      AUTH_TOKEN_FILE: "test-secret-file",
      SECRET_DIR: "test-secret-dir",
      SECRET_URL_PATH: "test-secret-url-path",
      API_KEY: "/var/lib/test-secret-key",
      API_SECRET: "/tmp/test-secret-absolute",
      API_PASSWORD: "./test-secret-relative",
      API_TOKEN: "~/test-secret-home",
      API_NUMERIC_TOKEN: "123456789",
      DEBUG_TOKEN: "true",
      LOG_LEVEL: "verbose",
    });

    expect(values.map((entry) => entry.name).sort()).toEqual([
      "env:AUTH_TOKEN",
      "env:OPENAI_API_KEY",
    ]);
    expect(values.map((entry) => entry.value).sort()).toEqual([
      "test-secret-auth-token",
      "test-secret-openai",
    ]);
  });

  it("drops values shorter than eight characters", () => {
    expect(collectEnvSecretValues({ API_KEY: "1234567" })).toEqual([]);
  });
});

describe("maskSecrets", () => {
  beforeEach(() => {
    resetSecretMaskerForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetSecretMaskerForTests();
  });

  it("returns the same reference when nothing is registered or nothing matches", () => {
    const input = { stdout: "no secrets here", stderr: "", interrupted: false };
    expect(maskSecrets(input)).toBe(input);

    registerSecret("test-secret-present");
    expect(maskSecrets(input)).toBe(input);
  });

  it("replaces nested strings without mutating the original and preserves sibling references", () => {
    registerSecret("test-secret-bearer-token", "mcp:arbor:headers:Authorization");
    const shared = { ok: true };
    const input = {
      stdout: "Authorization: Bearer test-secret-bearer-token",
      stderr: "",
      interrupted: false,
      nested: { lines: ["test-secret-bearer-token"] },
      shared,
    };

    const masked = maskSecrets(input);

    expect(masked).not.toBe(input);
    expect(masked.stdout).toBe("Authorization: Bearer [REDACTED:mcp:arbor:headers:Authorization]");
    expect(masked.stderr).toBe("");
    expect(masked.interrupted).toBe(false);
    expect(masked.nested).not.toBe(input.nested);
    expect(masked.nested.lines[0]).toBe("[REDACTED:mcp:arbor:headers:Authorization]");
    expect(masked.shared).toBe(shared);
    expect(input.stdout).toBe("Authorization: Bearer test-secret-bearer-token");
    expect(Object.getPrototypeOf(masked)).toBe(Object.prototype);
  });

  it("masks diff lines and standalone tokens regardless of the surrounding line prefix", () => {
    registerSecretValueSource("test", () => [
      { name: "mcp:api:headers:X-API-KEY", value: "test-secret-api-key-value" },
      { name: "mcp:exa:url:exaApiKey", value: "test-secret-query-value" },
    ]);

    expect(maskSecrets("-    X-API-KEY: test-secret-api-key-value")).toBe(
      "-    X-API-KEY: [REDACTED:mcp:api:headers:X-API-KEY]",
    );
    expect(maskSecrets("+url: https://h/mcp?exaApiKey=test-secret-query-value")).toBe(
      "+url: https://h/mcp?exaApiKey=[REDACTED:mcp:exa:url:exaApiKey]",
    );
    expect(maskSecrets("test-secret-api-key-value")).toBe(
      "[REDACTED:mcp:api:headers:X-API-KEY]",
    );
  });

  it("replaces the longest value first even when the shorter one is registered first", () => {
    registerSecretValueSource("short-source", () => [
      { name: "short", value: "test-secret-token" },
    ]);
    registerSecretValueSource("long-source", () => [
      { name: "long", value: "test-secret-token-long" },
    ]);

    expect(maskSecrets("test-secret-token-long")).toBe("[REDACTED:long]");
    expect(maskSecrets("test-secret-token")).toBe("[REDACTED:short]");
  });

  it("keeps the output shape and symbol-keyed own properties of a copied plain object", () => {
    registerSecret("test-secret-shape-token");
    const symbolKey = Symbol("meta");
    const response: Record<PropertyKey, unknown> & {
      stdout: string;
      stderr: string;
      interrupted: boolean;
    } = {
      stdout: "token test-secret-shape-token",
      stderr: "",
      interrupted: false,
      [symbolKey]: { label: "keep-me" },
    };

    const masked = maskSecrets(response);

    expect(masked).not.toBe(response);
    expect(masked).toMatchObject({ stderr: "", interrupted: false });
    expect(masked.stdout).toBe("token [REDACTED:test:value]");
    expect(masked[symbolKey]).toEqual({ label: "keep-me" });
  });

  it("passes Date, Buffer, Uint8Array, Map, Set, and class instances through untouched", () => {
    registerSecret("test-secret-note-value");
    class Widget {
      readonly value = "test-secret-widget-class";
    }
    const date = new Date(0);
    const buffer = Buffer.from("test-secret-buffer-value");
    const bytes = new Uint8Array([1, 2, 3]);
    const map = new Map([["token", "test-secret-map-value"]]);
    const set = new Set(["test-secret-set-value"]);
    const widget = new Widget();
    const input = {
      date,
      buffer,
      bytes,
      map,
      set,
      widget,
      note: "test-secret-note-value",
    };

    const masked = maskSecrets(input);

    expect(masked).not.toBe(input);
    expect(masked.note).toBe("[REDACTED:test:value]");
    expect(masked.date).toBe(date);
    expect(masked.buffer).toBe(buffer);
    expect(masked.bytes).toBe(bytes);
    expect(masked.map).toBe(map);
    expect(masked.set).toBe(set);
    expect(masked.widget).toBe(widget);
  });

  it("survives cyclic references and keeps the cycle inside the masked copy", () => {
    registerSecret("test-secret-cycle-value");
    const cycle: Record<string, unknown> = { stdout: "test-secret-cycle-value" };
    cycle.self = cycle;

    const masked = maskSecrets(cycle) as Record<string, unknown>;

    expect(masked).not.toBe(cycle);
    expect(masked.stdout).toBe("[REDACTED:test:value]");
    expect(masked.self).toBe(masked);
  });

  it("returns a secret-free cycle unchanged by reference", () => {
    const quiet: Record<string, unknown> = { stderr: "plain text" };
    quiet.self = quiet;

    expect(maskSecrets(quiet)).toBe(quiet);
  });

  it("caches provider results per source for thirty seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const provider = vi.fn(() => [{ name: "cached", value: "test-secret-cached" }]);
    registerSecretValueSource("cache-test", provider);

    expect(maskSecrets("test-secret-cached")).toBe("[REDACTED:cached]");
    expect(maskSecrets("test-secret-cached")).toBe("[REDACTED:cached]");
    expect(provider).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-01-01T00:00:31.000Z"));
    expect(maskSecrets("test-secret-cached")).toBe("[REDACTED:cached]");
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("keeps masking with the previous cache when a provider throws and warns once", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let calls = 0;
    const provider = vi.fn(() => {
      calls += 1;
      if (calls > 1) throw new Error("registry unavailable");
      return [{ name: "flaky", value: "test-secret-flaky" }];
    });
    registerSecretValueSource("flaky", provider);

    expect(maskSecrets("test-secret-flaky")).toBe("[REDACTED:flaky]");
    vi.setSystemTime(new Date("2026-01-01T00:00:31.000Z"));

    expect(maskSecrets("test-secret-flaky")).toBe("[REDACTED:flaky]");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(provider).toHaveBeenCalledTimes(2);

    expect(maskSecrets("test-secret-flaky")).toBe("[REDACTED:flaky]");
    expect(provider).toHaveBeenCalledTimes(2);
  });
});
