import { describe, expect, it } from "vitest";
import { testMcpServer } from "../src/mcp_central/server_tester.js";

describe("MCP server tester", () => {
  it("reports connection failure without exposing query or header values", async () => {
    const result = await testMcpServer({ id: "test", name: "test", type: "streamable_http", config: {
      url: "http://127.0.0.1:1/mcp?value=fake-query-value", headers: { Authorization: "fake-header-value" },
    } }, {}, 1000);
    expect(result.ok).toBe(false);
    expect(result.error_stage).toBe("connect");
    expect(JSON.stringify(result)).not.toContain("fake-query-value");
    expect(JSON.stringify(result)).not.toContain("fake-header-value");
  });
});
