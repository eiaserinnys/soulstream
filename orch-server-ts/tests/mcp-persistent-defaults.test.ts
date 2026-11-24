import { describe, expect, it, vi } from "vitest";
import { executeMcpTool } from "../src/mcp/tool_executor.js";
import type { McpHostOptions } from "../src/mcp/types.js";
import type { CallToolResult } from "@soulstream/mcp-contract";

const value = { model_preset: "preset-a", fallback_models: [] };
const result = { value, version: 1, source: "settings" };

describe("global persistent defaults MCP", () => {
  it("requires a persisted administrator and returns the same value for reads and writes", async () => {
    const service = { get: vi.fn(async () => result), put: vi.fn(async () => result) };
    const options = { persistentDefaults: { service, resolveCaller: async (id: string) => id === "admin" ? { ownerEmail: "admin@example.com" } : null,
      isAdminEmail: (email: string) => email === "admin@example.com" } } as unknown as McpHostOptions;
    const call = (name: string, args: Record<string, unknown>, callerSessionId: string | null, principal: "internal" | "external" = "internal") =>
      executeMcpTool(options, name as never, args, { principal, callerSessionId, nodeId: "node" }) as Promise<CallToolResult>;
    expect((await call("get_persistent_session_defaults", {}, null)).isError).toBe(true);
    expect((await call("get_persistent_session_defaults", {}, "missing")).isError).toBe(true);
    expect((await call("get_persistent_session_defaults", {}, "admin", "external")).isError).toBe(true);
    expect((await call("get_persistent_session_defaults", {}, "admin")).structuredContent).toEqual(result);
    expect((await call("update_persistent_session_defaults", { value, expectedVersion: 0 }, "admin")).structuredContent).toEqual(result);
    expect(service.put).toHaveBeenCalledWith({ value, expectedVersion: 0, updatedBy: "admin@example.com" });
  });
});
