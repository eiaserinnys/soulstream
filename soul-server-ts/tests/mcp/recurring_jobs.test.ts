import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { McpRuntime } from "../../src/mcp/runtime.js";
import { withMcpRequestContext } from "../../src/mcp/request_context.js";
import { registerRecurringJobTools } from "../../src/mcp/tools/recurring_jobs.js";

describe("recurring-job MCP tools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects every recurring operation for an untrusted external caller", async () => {
    const { call, registered } = register();
    expect([...registered.keys()]).toEqual([
      "list_recurring_jobs",
      "get_recurring_job",
      "preview_recurring_schedule",
      "create_recurring_job",
      "update_recurring_job",
      "run_recurring_job",
      "archive_recurring_job",
      "list_recurring_job_runs",
    ]);

    for (const tool of registered.keys()) {
      const result = await withMcpRequestContext({
        callerSessionId: "spoofed-session",
        principal: { authority: "external", source: "llm", displayName: "External LLM" },
      }, async () => await call(tool, { caller_session_id: "also-spoofed" }));
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual(expect.objectContaining({
        error: expect.stringContaining("untrusted external or LLM"),
      }));
    }
  });

  it("uses the verified normal caller-session actor for query, creation, and update", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ jobs: [] }))
      .mockResolvedValueOnce(response({ job: { job_id: "job-1" } }))
      .mockResolvedValueOnce(response({ job: { job_id: "job-1", version: 2 } }));
    vi.stubGlobal("fetch", fetch);
    const { call } = register();

    const listed = await withMcpRequestContext(
      { callerSessionId: "caller-session" },
      async () => await call("list_recurring_jobs", {}),
    );
    const created = await withMcpRequestContext(
      { callerSessionId: "caller-session" },
      async () => await call("create_recurring_job", createInput()),
    );
    const updated = await withMcpRequestContext(
      { callerSessionId: "caller-session" },
      async () => await call("update_recurring_job", {
        job_id: "job-1",
        expected_version: 1,
        enabled: true,
      }),
    );

    expect(listed.isError).not.toBe(true);
    expect(created.structuredContent).toEqual({ job: { job_id: "job-1" } });
    expect(updated.structuredContent).toEqual({ job: { job_id: "job-1", version: 2 } });
    expect(fetch).toHaveBeenCalledTimes(3);
    const listBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    const createBody = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(listBody.actor).toEqual(expect.objectContaining({
      ownerEmail: "owner@example.com",
      actorId: "caller-session",
      source: "agent",
    }));
    expect(createBody).toEqual(expect.objectContaining({
      name: "music recommendation",
      idempotency_key: "recurring:create:1",
      enabled: false,
      actor: expect.objectContaining({ ownerEmail: "owner@example.com" }),
    }));
    const updateBody = JSON.parse(String(fetch.mock.calls[2]?.[1]?.body));
    expect(updateBody).toEqual(expect.objectContaining({
      job_id: "job-1",
      expected_version: 1,
      enabled: true,
      actor: expect.objectContaining({
        ownerEmail: "owner@example.com",
        actorId: "caller-session",
        source: "agent",
      }),
    }));
  });
});

function register() {
  const registered = new Map<string, { handler: Function }>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Function) {
      registered.set(name, { handler });
    },
  } as unknown as McpServer;
  registerRecurringJobTools(server, runtime());
  return {
    registered,
    async call(name: string, input: Record<string, unknown>) {
      const tool = registered.get(name);
      if (!tool) throw new Error(`missing tool: ${name}`);
      return await tool.handler(input, {});
    },
  };
}

function runtime(): McpRuntime {
  return {
    nodeId: "node-a",
    taskManager: {
      getTask(sessionId: string) {
        return sessionId === "caller-session"
          ? { profileId: "roselin", callerInfo: { email: "owner@example.com" } }
          : undefined;
      },
    },
    agentRegistry: { get: () => ({ id: "roselin", name: "Roselin" }) },
    logger: { warn: vi.fn() },
    orch: { baseUrl: "http://orch.test", headers: { authorization: "Bearer token" } },
  } as unknown as McpRuntime;
}

function createInput() {
  return {
    name: "music recommendation",
    prompt: "recommend music",
    idempotency_key: "recurring:create:1",
    timezone: "Asia/Seoul",
    schedule_expressions: ["0 9,12 * * 1-5"],
    node_id: "node-a",
    agent_id: "roselin",
    model_preset: null,
    container: { kind: "folder", id: "folder-a" },
    folder_id: "folder-a",
    enabled: false,
  };
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
