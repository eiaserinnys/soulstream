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
      JSON.stringify({ detail: { error: { message: "idempotency key conflict" } } }),
      { status: 409 },
    )));
    const client = new SessionMutationHostClient({
      orch: { baseUrl: "http://orchestrator.test", headers: {} },
      logger,
    });

    await expect(client.deleteSession("session-a", "delete-session-a"))
      .rejects.toThrow("idempotency key conflict");
  });
});
