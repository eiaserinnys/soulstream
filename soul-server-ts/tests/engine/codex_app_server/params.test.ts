import { describe, expect, it } from "vitest";

import {
  buildThreadResumeParams,
  buildThreadStartParams,
  buildTurnStartParams,
} from "../../../src/engine/codex_app_server/params.js";

describe("Codex app-server parameter builders", () => {
  it("builds thread/start params with current wire defaults", () => {
    expect(
      buildThreadStartParams(
        {
          prompt: "hello",
          model: "  gpt-5.5  ",
          systemPrompt: "base instructions",
        },
        "/work",
      ),
    ).toEqual({
      model: "gpt-5.5",
      modelProvider: null,
      serviceTier: null,
      cwd: "/work",
      runtimeWorkspaceRoots: ["/work"],
      approvalPolicy: "never",
      approvalsReviewer: null,
      sandbox: "danger-full-access",
      permissions: null,
      config: null,
      serviceName: "soul-server-ts",
      baseInstructions: "base instructions",
      developerInstructions: null,
      personality: null,
      ephemeral: false,
      sessionStartSource: "startup",
      threadSource: "user",
      environments: null,
      dynamicTools: null,
      mockExperimentalField: null,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    });
  });

  it("builds thread/resume params with resume id and nullable model/system defaults", () => {
    expect(
      buildThreadResumeParams(
        {
          prompt: "resume",
          resumeSessionId: "thread-existing",
          model: "   ",
        },
        "/work",
      ),
    ).toEqual({
      threadId: "thread-existing",
      history: null,
      path: null,
      model: null,
      modelProvider: null,
      serviceTier: null,
      cwd: "/work",
      runtimeWorkspaceRoots: ["/work"],
      approvalPolicy: "never",
      approvalsReviewer: null,
      sandbox: "danger-full-access",
      permissions: null,
      config: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      excludeTurns: false,
      persistExtendedHistory: false,
    });
  });

  it("routes soulstream MCP through the internal listener with the current session header", () => {
    const mcpServers = [
      {
        type: "stdio" as const,
        name: "local",
        command: "node",
        args: ["server.js"],
        env: { TOKEN: "secret" },
        cwd: "/mcp",
      },
      {
        type: "streamable_http" as const,
        name: "soulstream",
        url: "http://127.0.0.1:3105/mcp",
        headers: {
          Authorization: "Bearer secret",
          "X-Soulstream-Agent-Session-Id": "stale-session",
        },
      },
      {
        type: "streamable_http" as const,
        name: "atom",
        url: "http://127.0.0.1:4200/mcp",
        headers: { "x-atom-key": "kept" },
      },
      {
        type: "sse" as const,
        name: "outline",
        url: "http://127.0.0.1:3103/sse",
      },
    ];
    const expectedConfig = {
      mcp_servers: {
        local: {
          command: "node",
          args: ["server.js"],
          env: { TOKEN: "secret" },
          cwd: "/mcp",
          enabled: true,
        },
        soulstream: {
          url: "http://127.0.0.1:3106/mcp/internal",
          http_headers: {
            Authorization: "Bearer secret",
            "x-soulstream-agent-session-id": "agent-session-1",
          },
          enabled: true,
        },
        atom: {
          url: "http://127.0.0.1:4200/mcp",
          http_headers: { "x-atom-key": "kept" },
          enabled: true,
        },
      },
    };

    expect(
      buildThreadStartParams(
        { prompt: "start", agentSessionId: "agent-session-1" },
        "/work",
        mcpServers,
        "http://127.0.0.1:3106/mcp/internal",
      ).config,
    ).toEqual(expectedConfig);
    expect(
      buildThreadResumeParams(
        {
          prompt: "resume",
          resumeSessionId: "thread-existing",
          agentSessionId: "agent-session-1",
        },
        "/work",
        mcpServers,
        "http://127.0.0.1:3106/mcp/internal",
      ).config,
    ).toEqual(expectedConfig);
  });

  it("fails closed when a soulstream HTTP MCP server has no internal listener URL", () => {
    expect(() =>
      buildThreadStartParams(
        { prompt: "start", agentSessionId: "agent-session-1" },
        "/work",
        [{
          type: "streamable_http",
          name: "soulstream",
          url: "http://127.0.0.1:3105/mcp",
        }],
      )
    ).toThrow(
      /Soulstream internal HTTP MCP server requires a node-local internalMcpUrl/,
    );
  });

  it("fails closed when a soulstream HTTP MCP server has no agent session id", () => {
    expect(() =>
      buildThreadStartParams(
        { prompt: "start" },
        "/work",
        [{
          type: "streamable_http",
          name: "soulstream",
          url: "http://127.0.0.1:3105/mcp",
        }],
        "http://127.0.0.1:3106/mcp/internal",
      )
    ).toThrow(/requires an agentSessionId/);
  });

  it("keeps an explicit empty MCP config when every resolved server uses SSE", () => {
    const sseOnlyServers = [
      {
        type: "sse" as const,
        name: "outline",
        url: "http://127.0.0.1:3103/sse",
      },
      {
        type: "sse" as const,
        name: "eb-lore",
        url: "http://127.0.0.1:3300/sse",
      },
    ];

    expect(
      buildThreadStartParams(
        { prompt: "start" },
        "/work",
        sseOnlyServers,
      ).config,
    ).toEqual({ mcp_servers: {} });
  });

  it("builds turn/start params with input attachments and reasoning effort policy", () => {
    expect(
      buildTurnStartParams(
        "thread-1",
        {
          prompt: "inspect",
          imageAttachmentPaths: ["/tmp/a.png", "/tmp/b.png"],
          model: "gpt-5.5",
          reasoningEffort: "high",
        },
        "/work",
      ),
    ).toEqual({
      threadId: "thread-1",
      input: [
        { type: "text", text: "inspect", text_elements: [] },
        { type: "localImage", path: "/tmp/a.png" },
        { type: "localImage", path: "/tmp/b.png" },
      ],
      responsesapiClientMetadata: null,
      environments: null,
      cwd: "/work",
      runtimeWorkspaceRoots: ["/work"],
      approvalPolicy: "never",
      approvalsReviewer: null,
      sandboxPolicy: { type: "dangerFullAccess" },
      permissions: null,
      model: "gpt-5.5",
      serviceTier: null,
      effort: "high",
      summary: null,
      personality: null,
      outputSchema: null,
      collaborationMode: null,
    });
  });

  it("drops reasoning effort for non-reasoning models without changing the model", () => {
    expect(
      buildTurnStartParams(
        "thread-1",
        {
          prompt: "legacy",
          model: "gpt-4o",
          reasoningEffort: "xhigh",
        },
        "/work",
      ),
    ).toMatchObject({
      model: "gpt-4o",
      effort: null,
    });
  });
});
