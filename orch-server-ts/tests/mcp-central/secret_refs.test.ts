import { describe, expect, it } from "vitest";

import {
  extractHostedToolSecrets,
  extractServerSecrets,
} from "../../src/mcp_central/secret_refs.js";
import type { McpServerDefinition } from "../../src/mcp_central/types.js";

function definition(config: Record<string, unknown>): McpServerDefinition {
  return { type: "streamable_http", config };
}

describe("secret reference extraction", () => {
  it("rejects a value that mixes secret and env references", () => {
    const mixed = definition({
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer {{secret:token}} {{env:TOKEN}}" },
    });

    expect(() => extractServerSecrets("srv-1", mixed, {})).toThrow(expect.objectContaining({
      code: "MCP_MIXED_SECRET_ENV_REF",
      statusCode: 400,
    }));
  });

  it("mixes secret and env references in the URL before the query", () => {
    const mixed = definition({
      url: "https://example.com/{{secret:host}}/{{env:HOST}}/mcp",
    });

    expect(() => extractServerSecrets("srv-1", mixed, {})).toThrow(expect.objectContaining({
      code: "MCP_MIXED_SECRET_ENV_REF",
    }));
  });

  it("names a location deterministically so saving again replaces the same secret", () => {
    const first = extractServerSecrets(
      "srv-1",
      definition({ url: "https://example.com/mcp", headers: { "X-Api-Key": "fake-a" } }),
      {},
    );
    const second = extractServerSecrets(
      "srv-1",
      definition({ url: "https://example.com/mcp", headers: { "X-Api-Key": "fake-b" } }),
      {},
    );

    const firstName = [...first.secrets.keys()][0];
    const secondName = [...second.secrets.keys()][0];
    expect(firstName).toBeDefined();
    expect(firstName).toBe(secondName);
    expect(first.secrets.get(firstName!)).toBe("fake-a");
    expect(second.secrets.get(secondName!)).toBe("fake-b");
    expect(first.definition.config.headers).toEqual({ "X-Api-Key": `{{secret:${firstName}}}` });
  });

  it("keeps env references and env objects instead of moving them", () => {
    const extracted = extractServerSecrets(
      "srv-1",
      { type: "stdio", config: { command: "run", env: {
        KEEP: "{{env:HOME}}",
        KEEP_OBJECT: { env: "TOKEN" },
        KEEP_SECRET: "{{secret:already}}",
        MOVE: "fake-plain",
      } } },
      {},
    );

    expect(extracted.definition.config.env).toEqual({
      KEEP: "{{env:HOME}}",
      KEEP_OBJECT: { env: "TOKEN" },
      KEEP_SECRET: "{{secret:already}}",
      MOVE: "{{secret:srv-srv-1-env-MOVE}}",
    });
    expect([...extracted.secrets.entries()]).toEqual([["srv-srv-1-env-MOVE", "fake-plain"]]);
  });

  it("moves query values and keeps the query key", () => {
    const extracted = extractServerSecrets(
      "srv-1",
      definition({ url: "https://example.com/mcp?key=fake-key&mode=fast" }),
      {},
    );

    expect(extracted.definition.config.url).toBe(
      "https://example.com/mcp?key=%7B%7Bsecret%3Asrv-srv-1-qry-0%7D%7D"
        + "&mode=%7B%7Bsecret%3Asrv-srv-1-qry-1%7D%7D",
    );
    expect([...extracted.secrets.values()]).toEqual(["fake-key", "fast"]);
  });

  it("applies the same rule to node overrides with their own names", () => {
    const extracted = extractServerSecrets(
      "srv-1",
      definition({ url: "https://example.com/mcp" }),
      {
        "node-a": {
          type: "stdio",
          config: { command: "run", env: { TOKEN: "fake-override" } },
        },
      },
    );

    expect(extracted.node_overrides["node-a"]?.config.env).toEqual({
      TOKEN: "{{secret:srv-srv-1-ovr-node-a-env-TOKEN}}",
    });
    expect([...extracted.secrets.keys()]).toEqual(["srv-srv-1-ovr-node-a-env-TOKEN"]);
  });

  it("moves hosted_mcp authorization, headers and server_url query values", () => {
    const extracted = extractHostedToolSecrets("profile-1", [
      { type: "web_search" },
      {
        type: "hosted_mcp",
        server_label: "remote",
        authorization: "Bearer fake-auth",
        headers: { "X-Key": "fake-header" },
        server_url: "https://example.com/mcp?token=fake-query",
      },
    ]);

    const tool = extracted.hosted_tools[1] as Record<string, unknown>;
    expect(tool.authorization).toBe("{{secret:prof-profile-1-ht1-auth}}");
    expect(tool.headers).toEqual({ "X-Key": "{{secret:prof-profile-1-ht1-hdr-X-Key}}" });
    expect(tool.server_url).toBe(
      "https://example.com/mcp?token=%7B%7Bsecret%3Aprof-profile-1-ht1-qry-0%7D%7D",
    );
    expect([...extracted.secrets.values()]).toEqual([
      "Bearer fake-auth",
      "fake-header",
      "fake-query",
    ]);
    expect(extracted.hosted_tools[0]).toEqual({ type: "web_search" });
  });
});
