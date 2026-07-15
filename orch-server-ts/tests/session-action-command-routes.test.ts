import { describe, expect, it, vi } from "vitest";

import {
  PendingNodeCommandTimeoutError,
  createApp,
  loadContractFixtures,
  parseOrchServerConfig,
  registerSessionActionCommandRoutes,
  sessionActionCommandRouteAuthRequirements,
} from "../src/index.js";
import {
  createActionHarness,
  createHarnessCore,
} from "./session-action-command-test-helpers.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

describe("session action command HTTP route harness", () => {
  const fixtures = loadContractFixtures();

  it("keeps session action command routes disabled on the default app", async () => {
    const app = createApp({ config });

    for (const [url, payload] of [
      ["/api/sessions/sess-contract/intervene", { text: "hello" }],
      ["/api/sessions/sess-contract/message", { text: "hello" }],
      ["/api/sessions/sess-contract/interrupt", {}],
      ["/api/sessions/sess-contract/review/acknowledge", {}],
      ["/api/sessions/sess-contract/tool-approvals/approval-1/approve", {}],
      ["/api/sessions/sess-contract/tool-approvals/approval-1/reject", {}],
      ["/api/sessions/sess-contract/realtime/call", { offerSdp: "offer" }],
      ["/api/sessions/sess-contract/realtime/events", { event: { type: "ping" } }],
      [
        "/api/sessions/sess-contract/realtime/tool-approvals/approval-1/resolve",
        { decision: "approved" },
      ],
    ] as const) {
      expect(
        await app.inject({
          method: "POST",
          url,
          payload,
        }),
      ).toMatchObject({ statusCode: 404 });
    }

    await app.close();
  });

  it("registers Python auth contract rows for action routes", async () => {
    expect(sessionActionCommandRouteAuthRequirements).toEqual({
      "POST /api/sessions/:session_id/intervene": true,
      "POST /api/sessions/:session_id/message": true,
      "POST /api/sessions/:session_id/interrupt": true,
      "POST /api/sessions/:session_id/review/acknowledge": true,
      "POST /api/sessions/:session_id/tool-approvals/:approval_id/approve": true,
      "POST /api/sessions/:session_id/tool-approvals/:approval_id/reject": true,
      "POST /api/sessions/:session_id/realtime/call": true,
      "POST /api/sessions/:session_id/realtime/events": true,
      "POST /api/sessions/:session_id/realtime/tool-approvals/:approval_id/resolve": true,
    });

    const routeRows = fixtures.routeInventory.routes
      .filter((route) =>
        [
          "intervene",
          "deprecated_session_message",
          "interrupt_session",
          "approve_tool",
          "reject_tool",
          "create_realtime_call",
          "relay_realtime_event",
          "resolve_realtime_tool_approval",
        ].includes(route.name),
      )
      .map((route) => [route.order, route.methods[0], route.path, route.authRequired]);

    expect(routeRows).toEqual([
      [13, "POST", "/api/sessions/{session_id}/intervene", true],
      [14, "POST", "/api/sessions/{session_id}/message", true],
      [15, "POST", "/api/sessions/{session_id}/interrupt", true],
      [23, "POST", "/api/sessions/{session_id}/tool-approvals/{approval_id}/approve", true],
      [24, "POST", "/api/sessions/{session_id}/tool-approvals/{approval_id}/reject", true],
      [25, "POST", "/api/sessions/{session_id}/realtime/call", true],
      [26, "POST", "/api/sessions/{session_id}/realtime/events", true],
      [
        27,
        "POST",
        "/api/sessions/{session_id}/realtime/tool-approvals/{approval_id}/resolve",
        true,
      ],
    ]);
  });

  it("normalizes intervene body and prevents command envelope override", async () => {
    const { app, sent } = createActionHarness();

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-contract/intervene",
      payload: {
        type: "realtime_event",
        requestId: "malicious-command-id",
        fireAndForget: true,
        text: "look here",
        user: "operator",
        attachment_paths: ["/tmp/a.png"],
        contextItems: [{ type: "note", text: "extra" }],
        caller_info: { source: "browser", display_name: "서소영" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", type: "intervene_ack" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: "intervene",
      requestId: "action-intervene-2-1700000000000",
      agentSessionId: "sess-contract",
      text: "look here",
      user: "operator",
      attachment_paths: ["/tmp/a.png"],
      extra_context_items: [{ type: "note", text: "extra" }],
      caller_info: { source: "browser", display_name: "서소영" },
    });

    await app.close();
  });

  it("resolves caller_info per intervention across user → relay → user", async () => {
    const browserCaller = {
      source: "browser",
      display_name: "서소영",
      user_id: "eiaserinnys@gmail.com",
      avatar_url: "https://example.test/user.png",
    };
    const relayCaller = {
      source: "agent",
      display_name: "로젤린 (codex)",
      user_id: "roselin_codex",
      agent_id: "roselin_codex",
      agent_node: "eiaserinnys",
    };
    const resolveCallerInfo = vi.fn(
      async (
        _request,
        bodyCallerInfo: Record<string, unknown> | undefined,
        _targetSessionId: string,
      ) =>
        bodyCallerInfo ?? browserCaller,
    );
    const { app, sent } = createActionHarness({ resolveCallerInfo });

    for (const payload of [
      { text: "첫 사용자 메시지", user: "dashboard" },
      { text: "피위임자 완료 보고", user: "agent", caller_info: relayCaller },
      { text: "둘째 사용자 메시지", user: "dashboard" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions/sess-contract/intervene",
        payload,
      });
      expect(response.statusCode).toBe(200);
    }

    expect(resolveCallerInfo).toHaveBeenCalledTimes(3);
    expect(resolveCallerInfo.mock.calls.map((call) => call[2])).toEqual([
      "sess-contract",
      "sess-contract",
      "sess-contract",
    ]);
    expect(sent.map((message) => message.caller_info)).toEqual([
      browserCaller,
      relayCaller,
      browserCaller,
    ]);

    await app.close();
  });

  it("returns deprecated 410 envelope for singular message without sending a node command", async () => {
    const { app, sent } = createActionHarness();

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-contract/message",
      payload: { text: "stale client" },
    });

    expect(response.statusCode).toBe(410);
    expect(response.headers["x-soulstream-deprecated-path"]).toBe(
      "/api/sessions/sess-contract/message",
    );
    expect(response.headers["x-soulstream-replacement-path"]).toBe(
      "/api/sessions/sess-contract/intervene",
    );
    expect(response.headers["x-soulstream-desktop-action"]).toBe("hard-reload");
    expect(response.json()).toMatchObject({
      error: {
        code: "DEPRECATED_API_PATH",
        deprecatedPath: "/api/sessions/sess-contract/message",
        replacementPath: "/api/sessions/sess-contract/intervene",
        replacementMethod: "POST",
      },
    });
    expect(sent).toEqual([]);

    await app.close();
  });

  it("maps interrupt command and ack errors to Python-compatible statuses", async () => {
    const cases = [
      ["SESSION_NOT_FOUND", 404],
      ["SESSION_NOT_RUNNING", 409],
      ["INTERRUPT_NOT_SUPPORTED", 422],
    ] as const;

    for (const [code, statusCode] of cases) {
      const { app, sent } = createActionHarness({
        ackFor: () => ({
          type: "interrupt_session_ack",
          status: "error",
          code,
          message: `interrupt ${code}`,
        }),
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/sessions/sess-contract/interrupt",
      });

      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({
        error: { code, message: `interrupt ${code}` },
      });
      expect(sent[0]).toMatchObject({
        type: "interrupt_session",
        agentSessionId: "sess-contract",
      });

      await app.close();
    }
  });

  it("routes review acknowledge and maps domain errors explicitly", async () => {
    const success = createActionHarness();
    const ok = await success.app.inject({
      method: "POST",
      url: "/api/sessions/sess-contract/review/acknowledge",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      status: "ok",
      reviewState: "acknowledged",
      changed: true,
    });
    expect(success.sent[0]).toMatchObject({
      type: "acknowledge_session_review",
      agentSessionId: "sess-contract",
    });
    await success.app.close();

    for (const [code, statusCode] of [
      ["SESSION_NOT_FOUND", 404],
      ["REVIEW_NOT_REQUIRED", 409],
      ["REVIEW_NOT_PENDING", 409],
    ] as const) {
      const failure = createActionHarness({
        ackFor: () => ({
          type: "acknowledge_session_review_ack",
          status: "error",
          code,
          message: code,
        }),
      });
      const response = await failure.app.inject({
        method: "POST",
        url: "/api/sessions/sess-contract/review/acknowledge",
      });
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({ error: { code } });
      await failure.app.close();
    }
  });

  it("sends tool approval approve/reject payloads and preserves approvalId on errors", async () => {
    const { app, sent } = createActionHarness({
      ackFor: (message) =>
        message.type === "reject_tool"
          ? {
              type: "tool_approval_ack",
              status: "error",
              code: "TOOL_APPROVAL_ALREADY_RESOLVED",
              message: "already resolved",
              approvalId: message.approvalId,
            }
          : {
              type: "tool_approval_ack",
              status: "ok",
              approvalId: message.approvalId,
              decision: "approved",
            },
    });

    const approve = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-contract/tool-approvals/approval-1/approve",
      payload: { message: "yes", alwaysApprove: true },
    });
    const reject = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-contract/tool-approvals/approval-1/reject",
      payload: { message: "no", alwaysReject: true },
    });

    expect(approve.statusCode).toBe(200);
    expect(reject.statusCode).toBe(422);
    expect(reject.json()).toMatchObject({
      error: {
        code: "TOOL_APPROVAL_ALREADY_RESOLVED",
        approvalId: "approval-1",
      },
    });
    expect(sent).toEqual([
      expect.objectContaining({
        type: "approve_tool",
        agentSessionId: "sess-contract",
        approvalId: "approval-1",
        message: "yes",
        alwaysApprove: true,
      }),
      expect.objectContaining({
        type: "reject_tool",
        agentSessionId: "sess-contract",
        approvalId: "approval-1",
        message: "no",
        alwaysReject: true,
      }),
    ]);

    await app.close();
  });

  it("sends realtime call/events/approval payloads without forwarding secret-like call body keys", async () => {
    const { app, sent } = createActionHarness({
      ackFor: (message) => ({
        type:
          message.type === "realtime_create_call"
            ? "realtime_call_created"
            : message.type === "realtime_event"
              ? "realtime_event_ack"
              : "realtime_tool_approval_ack",
        status: "ok",
        agentSessionId: message.agentSessionId,
        approvalId: message.approvalId,
        decision: message.decision,
      }),
    });

    const call = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-contract/realtime/call",
      payload: {
        offer_sdp: "offer-sdp",
        model: "gpt-realtime",
        voice: "alloy",
        instructions: "be brief",
        apiKey: "secret",
        providerApiKey: "secret",
        OPENAI_API_KEY: "secret",
      },
    });
    const event = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-contract/realtime/events",
      payload: { event: { type: "input_audio_buffer.commit" }, callId: "call-1" },
    });
    const approval = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-contract/realtime/tool-approvals/approval-rt/resolve",
      payload: {
        decision: "approved",
        message: "voice ok",
        source: "voice",
        callId: "call-1",
      },
    });

    expect(call.statusCode).toBe(200);
    expect(event.statusCode).toBe(200);
    expect(approval.statusCode).toBe(200);
    expect(sent[0]).toEqual({
      type: "realtime_create_call",
      requestId: "action-realtime_create_call-2-1700000000000",
      agentSessionId: "sess-contract",
      offerSdp: "offer-sdp",
      model: "gpt-realtime",
      voice: "alloy",
      instructions: "be brief",
    });
    expect(sent[0]).not.toHaveProperty("apiKey");
    expect(sent[0]).not.toHaveProperty("providerApiKey");
    expect(sent[0]).not.toHaveProperty("OPENAI_API_KEY");
    expect(sent[1]).toMatchObject({
      type: "realtime_event",
      agentSessionId: "sess-contract",
      event: { type: "input_audio_buffer.commit" },
      callId: "call-1",
    });
    expect(sent[2]).toMatchObject({
      type: "realtime_resolve_tool_approval",
      agentSessionId: "sess-contract",
      approvalId: "approval-rt",
      decision: "approved",
      message: "voice ok",
      source: "voice",
      callId: "call-1",
    });

    await app.close();
  });

  it("maps realtime ack status error to a 422 code/message envelope", async () => {
    const { app } = createActionHarness({
      ackFor: () => ({
        type: "realtime_tool_approval_ack",
        status: "error",
        code: "REALTIME_ERROR",
        message: "no call",
      }),
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/sess-contract/realtime/tool-approvals/approval-rt/resolve",
      payload: { decision: "rejected" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: { code: "REALTIME_ERROR", message: "no call" },
    });

    await app.close();
  });

  it("maps owner, transport, stale owner, and timeout failures consistently", async () => {
    const missingOwner = createActionHarness({ createSession: false });
    expect(
      await missingOwner.app.inject({
        method: "POST",
        url: "/api/sessions/missing/intervene",
        payload: { text: "hello" },
      }),
    ).toMatchObject({ statusCode: 404 });
    await missingOwner.app.close();

    const missingTransport = createActionHarness({ attachTransport: false });
    expect(
      await missingTransport.app.inject({
        method: "POST",
        url: "/api/sessions/sess-contract/intervene",
        payload: { text: "hello" },
      }),
    ).toMatchObject({ statusCode: 503 });
    expect(missingTransport.registry.getConnectedNode("fake-node")).toMatchObject({
      pendingCommandCount: 0,
    });
    await missingTransport.app.close();

    const staleOwner = createActionHarness();
    staleOwner.registry.disconnectNode("fake-node", {
      connectionId: staleOwner.connectionId,
      reason: "test",
    });
    expect(
      await staleOwner.app.inject({
        method: "POST",
        url: "/api/sessions/sess-contract/intervene",
        payload: { text: "hello" },
      }),
    ).toMatchObject({ statusCode: 503 });
    await staleOwner.app.close();

    const timeout = createActionHarness({
      bridgeOverride: {
        sendPendingCommand: async () => {
          throw new PendingNodeCommandTimeoutError({
            commandType: "interrupt_session",
            requestId: "timeout-1",
            timeoutMs: 5,
          });
        },
      },
    });
    expect(
      await timeout.app.inject({
        method: "POST",
        url: "/api/sessions/sess-contract/interrupt",
      }),
    ).toMatchObject({ statusCode: 503 });
    await timeout.app.close();
  });

  it("returns 400 for invalid action route bodies", async () => {
    const { app } = createActionHarness();

    expect(
      await app.inject({
        method: "POST",
        url: "/api/sessions/sess-contract/intervene",
        payload: {},
      }),
    ).toMatchObject({ statusCode: 400 });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/sessions/sess-contract/realtime/call",
        payload: { model: "missing offer" },
      }),
    ).toMatchObject({ statusCode: 400 });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/sessions/sess-contract/realtime/events",
        payload: { event: "not object" },
      }),
    ).toMatchObject({ statusCode: 400 });
    expect(
      await app.inject({
        method: "POST",
        url: "/api/sessions/sess-contract/realtime/tool-approvals/approval-rt/resolve",
        payload: { decision: "maybe" },
      }),
    ).toMatchObject({ statusCode: 400 });

    await app.close();
  });

  it("can be registered directly on a Fastify instance for route-boundary tests", async () => {
    const { router, bridge } = createHarnessCore();
    const app = createApp({ config });

    registerSessionActionCommandRoutes(app, { router, bridge });

    expect(
      await app.inject({
        method: "POST",
        url: "/api/sessions/missing/intervene",
        payload: { text: "hello" },
      }),
    ).toMatchObject({ statusCode: 404 });

    await app.close();
  });
});
