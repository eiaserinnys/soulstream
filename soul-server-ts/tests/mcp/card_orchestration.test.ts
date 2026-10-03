import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpRuntime } from "../../src/mcp/runtime.js";
import { withMcpRequestContext } from "../../src/mcp/request_context.js";
import { registerCardOrchestrationTools } from "../../src/mcp/tools/card_orchestration.js";
const policy = {
  enabled: false,
  candidates: [
    {
      agentId: "ariella-orchestrator",
      nodeId: "eiaserinnys",
      modelPreset: "claude-opus",
      minimumRemainingPercent: 15,
    },
  ],
  usageMaxAgeMs: 300000,
  sessionFolderId: null,
  systemFolderParentId: null,
};
afterEach(() => vi.unstubAllGlobals());
function register() {
  const tools = new Map<string, { inputSchema: any; handler: Function }>();
  const server = {
    registerTool: (name: string, config: any, handler: Function) =>
      tools.set(name, { ...config, handler }),
  } as unknown as McpServer;
  const runtime = {
    nodeId: "node",
    taskManager: {
      getTask: () => ({
        profileId: "ariella",
        callerInfo: { email: "admin@example.com" },
      }),
    },
    agentRegistry: { get: () => ({ id: "ariella", name: "아리엘라" }) },
    logger: { warn: vi.fn() },
    orch: {
      baseUrl: "http://orch.test",
      headers: { authorization: "Bearer service-token" },
    },
  } as unknown as McpRuntime;
  registerCardOrchestrationTools(server, runtime);
  return {
    tools,
    call: async (name: string, input: any) =>
      tools.get(name)!.handler(input, {}),
  };
}
it("exposes only administrator policy query and CAS write and preserves native caller attribution", async () => {
  const { tools, call } = register();
  expect([...tools.keys()]).toEqual([
    "get_card_orchestration_settings",
    "update_card_orchestration_settings",
  ]);
  const update = tools.get("update_card_orchestration_settings")!;
  const input = z
    .object(update.inputSchema)
    .parse({ expectedVersion: 1, policy });
  expect(() =>
    z
      .object(update.inputSchema)
      .parse({ expectedVersion: 1, policy: { ...policy, mutation: true } }),
  ).toThrow();
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(JSON.stringify({ content: [], structuredContent: { settings: { policy, version: 2 } } }), {
        status: 200,
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const result = await withMcpRequestContext(
    { callerSessionId: "native-caller" },
    () => call("update_card_orchestration_settings", input),
  );
  expect(result.isError).not.toBe(true);
  expect(fetch.mock.calls[0]![0]).toBe(
    "http://orch.test/api/mcp/host/update_card_orchestration_settings",
  );
  expect(
    JSON.parse(
      String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    ),
  ).toMatchObject({ args: { policy, expectedVersion: 1 }, context: { caller_session_id: "native-caller" } });
});
