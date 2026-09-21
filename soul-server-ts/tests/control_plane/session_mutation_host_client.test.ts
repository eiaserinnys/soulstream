import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionMutationHostClient } from
  "../../src/control_plane/persistence_host_clients.js";

const logger = pino({ level: "silent" });

describe("SessionMutationHostClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends transition fields and the mandatory idempotency key to the host boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("null", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SessionMutationHostClient({
      orch: {
        baseUrl: "http://orchestrator.test",
        headers: { authorization: "Bearer secret" },
      },
      logger,
    });
    const updatedAt = new Date("2026-08-06T00:00:00.000Z");

    await client.transitionSession(
      "session-a",
      {
        status: "running",
        termination_reason: null,
        review_state: "not_required",
      },
      "transition-session-a-1",
      updatedAt,
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://orchestrator.test/api/session-data/host/transition_session",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      args: [{
        session_id: "session-a",
        fields: {
          status: "running",
          termination_reason: null,
          review_state: "not_required",
        },
        idempotency_key: "transition-session-a-1",
        updated_at: updatedAt.toISOString(),
      }],
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("preserves caller_info on the wire and returns the central review decision", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      reviewRequired: true,
      reviewState: "not_required",
      reviewDecision: "central_policy",
      policyVersion: 4,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SessionMutationHostClient({
      orch: { baseUrl: "http://orchestrator.test", headers: {} },
      logger,
    });
    const now = new Date("2026-09-14T00:00:00.000Z");

    await expect(client.registerSession({
      sessionId: "session-a",
      nodeId: "node-a",
      agentId: null,
      claudeSessionId: null,
      sessionType: "claude",
      prompt: "inspect",
      clientId: null,
      status: "initializing",
      createdAt: now,
      updatedAt: now,
      callerSessionId: null,
      predecessorSessionId: null,
      callerInfo: {
        source: "external-llm",
        display_name: "External LLM",
        user_id: null,
      },
      reviewRequired: false,
      reviewState: "not_required",
    }, "register-session-a")).resolves.toMatchObject({
      reviewRequired: true,
      reviewDecision: "central_policy",
      policyVersion: 4,
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.args[0]).toMatchObject({
      caller_info: {
        source: "external-llm",
        display_name: "External LLM",
        user_id: null,
      },
      review_required: false,
    });
  });

  it("treats an old orchestrator {ok:true} response as a compatibility fallback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));
    const client = new SessionMutationHostClient({
      orch: { baseUrl: "http://orchestrator.test", headers: {} },
      logger,
    });
    const now = new Date("2026-09-14T00:00:00.000Z");
    await expect(client.registerSession({
      sessionId: "session-legacy-host",
      nodeId: "node-a",
      agentId: null,
      claudeSessionId: null,
      sessionType: "claude",
      prompt: "inspect",
      clientId: null,
      status: "initializing",
      createdAt: now,
      updatedAt: now,
      callerSessionId: null,
      predecessorSessionId: null,
      callerInfo: { source: "browser", email: "user@example.com" },
      reviewRequired: true,
      reviewState: "not_required",
    }, "register-legacy-host")).resolves.toBeUndefined();
  });

  it("returns a string review outcome from the JSON host response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify("acknowledged"),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    )));
    const client = new SessionMutationHostClient({
      orch: {
        baseUrl: "http://orchestrator.test",
        headers: { authorization: "Bearer secret" },
      },
      logger,
    });

    await expect(client.acknowledgeReview(
      "session-a",
      "acknowledge-session-a-1",
      new Date("2026-08-08T00:00:00.000Z"),
    )).resolves.toBe("acknowledged");
  });

  it("surfaces host rejection without a detached promise", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ detail: { error: {
        code: "IDEMPOTENCY_CONFLICT",
        message: "idempotency key conflict",
      } } }),
      { status: 409 },
    )));
    const client = new SessionMutationHostClient({
      orch: { baseUrl: "http://orchestrator.test", headers: {} },
      logger,
    });

    await expect(client.deleteSession("session-a", "delete-session-a"))
      .rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
        message: expect.stringContaining("idempotency key conflict"),
      });
  });
});
