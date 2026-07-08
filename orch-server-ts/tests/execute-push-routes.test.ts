import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  executeProxyRouteAuthRequirements,
  loadContractFixtures,
  parseOrchServerConfig,
  pushRouteAuthRequirements,
  type ExecuteProxyProvider,
  type PushRegistrationRepository,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

function createExecuteProvider(): ExecuteProxyProvider {
  return {
    executeNew: vi.fn(async () => ({
      agentSessionId: "sess-new",
      nodeId: "node-new",
      events: [
        { event: { type: "thinking", content: "생각", _event_id: 42 } },
        { event: { type: "complete", result: "done", _event_id: 43 } },
        { event: { type: "thinking", content: "after-complete", _event_id: 44 } },
      ],
    })),
    executeResume: vi.fn(async () => ({
      agentSessionId: "sess-existing",
      nodeId: "node-resume",
      events: [
        { payload: { type: "complete", result: "resumed" }, eventId: 99 },
      ],
    })),
  };
}

function createPushRepository(): PushRegistrationRepository {
  return {
    upsertToken: vi.fn(async () => undefined),
    deleteToken: vi.fn(async () => undefined),
  };
}

describe("Execute proxy and push route harnesses", () => {
  const fixtures = loadContractFixtures();

  it("keeps execute and push routes disabled on the default app", async () => {
    const app = createApp({ config });

    expect(await app.inject({
      method: "POST",
      url: "/api/execute",
      payload: { prompt: "hidden", profile: "agent" },
    })).toMatchObject({ statusCode: 404 });
    expect(await app.inject({
      method: "POST",
      url: "/api/push/register",
      payload: { token: "expo-token", deviceId: "device-1" },
    })).toMatchObject({ statusCode: 404 });
    expect(await app.inject({
      method: "DELETE",
      url: "/api/push/register/device-1",
    })).toMatchObject({ statusCode: 404 });

    await app.close();
  });

  it("registers Python auth contract rows for route inventory order 110-112", () => {
    expect(executeProxyRouteAuthRequirements).toEqual({
      "POST /api/execute": true,
    });
    expect(pushRouteAuthRequirements).toEqual({
      "POST /api/push/register": true,
      "DELETE /api/push/register/:device_id": true,
    });

    expect(fixtures.routeInventory.routes
      .filter((route) => route.order >= 110 && route.order <= 112)
      .map((route) => [route.order, route.methods[0], route.path, route.authRequired]))
      .toEqual([
        [110, "POST", "/api/execute", true],
        [111, "POST", "/api/push/register", true],
        [112, "DELETE", "/api/push/register/{device_id}", true],
      ]);
  });

  it("requires profile or agentId before starting a new execute session", async () => {
    const provider = createExecuteProvider();
    const app = createApp({
      config,
      executeProxyRoutes: { provider },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/execute",
      payload: { prompt: "hello" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      detail: {
        error: {
          code: "AGENT_PROFILE_REQUIRED",
          message: "New execute requests require profile or agentId",
          details: {
            hint: "Set SEOSOYOUNG_AGENT_ID or send profile/agentId in the request body",
          },
        },
      },
    });
    expect(provider.executeNew).not.toHaveBeenCalled();
    expect(provider.executeResume).not.toHaveBeenCalled();

    await app.close();
  });

  it("converts new execute payload aliases to Python request_dict shape and formats SSE", async () => {
    const provider = createExecuteProvider();
    const contextItems = [{ key: "k", label: "K", content: "C" }];
    const callerInfo = { source: "slack", email: "user@example.com" };
    const app = createApp({
      config,
      executeProxyRoutes: { provider },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "user-agent": "vitest-agent" },
      payload: {
        agentId: "codex-agent",
        node_id: "node-a",
        allowed_tools: ["Read"],
        disallowed_tools: ["Write"],
        claudePermissionMode: "acceptEdits",
        use_mcp: true,
        folder_id: "folder-a",
        system_prompt: "system",
        model: "gpt-5",
        reasoningEffort: "high",
        caller_info: callerInfo,
        context_items: contextItems,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toBe(
      'event: init\n' +
        'data: {"type":"init","agent_session_id":"sess-new","node_id":"node-new"}\n\n' +
        'event: thinking\n' +
        'id: 42\n' +
        'data: {"type":"thinking","content":"생각","_event_id":42}\n\n' +
        'event: complete\n' +
        'id: 43\n' +
        'data: {"type":"complete","result":"done","_event_id":43}\n\n',
    );
    expect(provider.executeNew).toHaveBeenCalledWith({
      prompt: "",
      nodeId: "node-a",
      profile: "codex-agent",
      allowed_tools: ["Read"],
      disallowed_tools: ["Write"],
      claude_permission_mode: "acceptEdits",
      use_mcp: true,
      folderId: "folder-a",
      system_prompt: "system",
      model: "gpt-5",
      reasoningEffort: "high",
      caller_info: callerInfo,
      extra_context_items: contextItems,
    });
    expect(provider.executeResume).not.toHaveBeenCalled();

    await app.close();
  });

  it("builds execute-proxy caller_info for new execute requests when omitted", async () => {
    const provider = createExecuteProvider();
    const app = createApp({
      config,
      executeProxyRoutes: { provider },
    });

    await app.inject({
      method: "POST",
      url: "/api/execute",
      headers: { "user-agent": "vitest-agent" },
      payload: { prompt: "hello", profile: "codex-agent" },
    });

    expect(provider.executeNew).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "hello",
      profile: "codex-agent",
      caller_info: expect.objectContaining({
        source: "execute-proxy",
        user_agent: "vitest-agent",
      }),
    }));

    await app.close();
  });

  it("passes through provider text responses for execute streams", async () => {
    const provider: ExecuteProxyProvider = {
      executeNew: vi.fn(async () => ({
        statusCode: 202,
        contentType: "text/event-stream",
        body: 'event: custom\ndata: {"ok":true}\n\n',
      })),
      executeResume: vi.fn(),
    };
    const app = createApp({
      config,
      executeProxyRoutes: { provider },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/execute",
      payload: { prompt: "hello", profile: "codex-agent" },
    });

    expect(response.statusCode).toBe(202);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toBe('event: custom\ndata: {"ok":true}\n\n');

    await app.close();
  });

  it("converts resume execute payload aliases and preserves provider SSE formatting", async () => {
    const provider = createExecuteProvider();
    const callerInfo = { source: "slack", display_name: "사용자" };
    const contextItems = [{ key: "attachment", content: "map.png" }];
    const app = createApp({
      config,
      executeProxyRoutes: { provider },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/execute",
      payload: {
        prompt: "continue",
        agent_session_id: "sess-existing",
        attachmentPaths: ["uploads/map.png"],
        caller_info: callerInfo,
        context_items: contextItems,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(
      'event: init\n' +
        'data: {"type":"init","agent_session_id":"sess-existing","node_id":"node-resume"}\n\n' +
        'event: complete\n' +
        'id: 99\n' +
        'data: {"type":"complete","result":"resumed"}\n\n',
    );
    expect(provider.executeResume).toHaveBeenCalledWith({
      agent_session_id: "sess-existing",
      prompt: "continue",
      attachment_paths: ["uploads/map.png"],
      caller_info: callerInfo,
      extra_context_items: contextItems,
    });
    expect(provider.executeNew).not.toHaveBeenCalled();

    await app.inject({
      method: "POST",
      url: "/api/execute",
      payload: {
        prompt: "continue again",
        agent_session_id: "sess-existing",
        attachment_paths: ["uploads/alt.png"],
      },
    });
    expect(provider.executeResume).toHaveBeenLastCalledWith({
      agent_session_id: "sess-existing",
      prompt: "continue again",
      attachment_paths: ["uploads/alt.png"],
    });

    await app.close();
  });

  it("requires JWT user email for push registration routes", async () => {
    const repository = createPushRepository();
    const app = createApp({
      config,
      pushRoutes: {
        repository,
        resolveJwtUser: () => ({ email: null }),
      },
    });

    const register = await app.inject({
      method: "POST",
      url: "/api/push/register",
      payload: { token: "expo-token", deviceId: "device-1" },
    });
    const deregister = await app.inject({
      method: "DELETE",
      url: "/api/push/register/device-1",
    });

    expect(register.statusCode).toBe(401);
    expect(register.json()).toEqual({
      detail: "JWT authentication required for push registration",
    });
    expect(deregister.statusCode).toBe(401);
    expect(repository.upsertToken).not.toHaveBeenCalled();
    expect(repository.deleteToken).not.toHaveBeenCalled();

    await app.close();
  });

  it("passes push register and deregister requests to the injected repository", async () => {
    const repository = createPushRepository();
    const app = createApp({
      config,
      pushRoutes: {
        repository,
        resolveJwtUser: () => ({ email: "User@Example.com" }),
      },
    });

    const register = await app.inject({
      method: "POST",
      url: "/api/push/register",
      payload: { token: "expo-token", deviceId: "device-1" },
    });
    const deregister = await app.inject({
      method: "DELETE",
      url: "/api/push/register/device-1",
    });

    expect(register.statusCode).toBe(200);
    expect(register.json()).toEqual({ ok: true });
    expect(deregister.statusCode).toBe(200);
    expect(deregister.json()).toEqual({ ok: true });
    expect(repository.upsertToken).toHaveBeenCalledWith(
      "User@Example.com",
      "device-1",
      "expo-token",
    );
    expect(repository.deleteToken).toHaveBeenCalledWith(
      "User@Example.com",
      "device-1",
    );

    await app.close();
  });
});
