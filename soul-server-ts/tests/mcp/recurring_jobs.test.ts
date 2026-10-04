import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { McpRuntime } from "../../src/mcp/runtime.js";
import { withMcpRequestContext } from "../../src/mcp/request_context.js";
import { registerRecurringJobTools } from "../../src/mcp/tools/recurring_jobs.js";

describe("recurring-job MCP tools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the verified normal caller-session actor for query, creation, and update", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ jobs: [] }))
      .mockResolvedValueOnce(response({ job: { job_id: "job-1" } }))
      .mockResolvedValueOnce(response({ job: { job_id: "job-1", version: 2 } }));
    vi.stubGlobal("fetch", fetch);
    const { call, registered } = register();
    expect([...registered.keys()]).toEqual([
      "list_recurring_jobs", "get_recurring_job", "preview_recurring_schedule", "create_recurring_job",
      "update_recurring_job", "run_recurring_job", "archive_recurring_job", "list_recurring_job_runs",
    ]);

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
    expect(listBody.context).toMatchObject({ caller_session_id: "caller-session", callerInfo: { email: "owner@example.com" } });
    expect(createBody.args).toEqual(expect.objectContaining({
      name: "music recommendation",
      idempotency_key: "recurring:create:1",
      enabled: false,
    }));
    expect(createBody.context.callerInfo.email).toBe("owner@example.com");
    const updateBody = JSON.parse(String(fetch.mock.calls[2]?.[1]?.body));
    expect(updateBody.args).toEqual(expect.objectContaining({
      job_id: "job-1",
      expected_version: 1,
      enabled: true,
    }));
    expect(updateBody.context).toMatchObject({ caller_session_id: "caller-session", callerInfo: { email: "owner@example.com" } });
  });

  it("forwards once run_at through the MCP schemas without a cron array", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ job: { job_id: "job-once" } }))
      .mockResolvedValueOnce(response({ job: { job_id: "job-once", version: 2 } }));
    vi.stubGlobal("fetch", fetch);
    const { call, registered } = register();
    const createTool = registered.get("create_recurring_job")!;
    const updateTool = registered.get("update_recurring_job")!;
    const { schedule_expressions: _scheduleExpressions, ...base } = createInput();
    const runAt = "2026-09-29T09:00:00+09:00";

    expect(createTool.config.description).toContain("1회");
    expect(createTool.config.description).toContain("idempotency_key");
    expect(createTool.config.inputSchema.schedule_expressions.isOptional()).toBe(true);
    expect(createTool.config.inputSchema.run_at.isOptional()).toBe(true);
    expect(updateTool.config.description).toContain("run_at");
    expect(updateTool.config.inputSchema.run_at.isOptional()).toBe(true);

    await withMcpRequestContext(
      { callerSessionId: "caller-session" },
      async () => await call("create_recurring_job", { ...base, run_at: runAt }),
    );
    await withMcpRequestContext(
      { callerSessionId: "caller-session" },
      async () => await call("update_recurring_job", {
        job_id: "job-once",
        expected_version: 1,
        run_at: "2026-09-30T09:00:00+09:00",
      }),
    );

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).args).toMatchObject({
      run_at: runAt,
      timezone: "Asia/Seoul",
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).args).not.toHaveProperty("schedule_expressions");
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).args).toMatchObject({
      job_id: "job-once",
      run_at: "2026-09-30T09:00:00+09:00",
    });
  });
  it("forwards an evicted session identity for central recovery without requiring memory email", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ jobs: [] })); vi.stubGlobal("fetch", fetch);
    const { call } = register();
    expect((await withMcpRequestContext({ callerSessionId: "evicted-session" }, () => call("list_recurring_jobs", {}))).isError).not.toBe(true);
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.context.caller_session_id).toBe("evicted-session");
    expect(body.context.callerInfo).not.toHaveProperty("email");
  });
});

function register() {
  const registered = new Map<string, {
    config: { description: string; inputSchema: Record<string, { isOptional(): boolean }> };
    handler: Function;
  }>();
  const server = {
    registerTool(name: string, config: unknown, handler: Function) {
      registered.set(name, { config: config as {
        description: string;
        inputSchema: Record<string, { isOptional(): boolean }>;
      }, handler });
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
    folder_id: "folder-a",
    enabled: false,
  };
}

function response(body: unknown): Response {
  return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(body, null, 2) }], structuredContent: body }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
