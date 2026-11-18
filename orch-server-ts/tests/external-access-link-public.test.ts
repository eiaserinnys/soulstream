/**
 * card #1457 — the public access link surface, route level.
 *
 * The five `/x` routes carry the key in the path and turn it into the only
 * identity. This suite drives them with fakes to pin the entrance judgment
 * (credential -> kind -> permission), the fixed error bodies and headers, the
 * message/status/history/stop contracts, and the long poll's wake and
 * pre-response re-check.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  hashExternalAccessKey,
  type ExternalAccessGrant,
} from "../src/external_access/external_access_grant_repository.js";
import { ExternalAccessTokenBucket } from "../src/external_access/external_access_token_bucket.js";
import { ExternalReplySignal } from "../src/external_access/external_reply_signal.js";
import {
  EXTERNAL_READ_RATE_PER_MINUTE,
  EXTERNAL_SEND_RATE_PER_MINUTE,
  type AdmitExternalInputResult,
  type ExternalRequestStatus,
  type ReadExternalRequestStatusResult,
} from "../src/external_access/external_input_service.js";
import {
  registerExternalAccessPublicRoutes,
  type ExternalAccessPublicRouteOptions,
} from "../src/external_access/public_link_routes.js";
import { RuntimeSessionEventHub } from "../src/runtime/session_event_hub.js";

const PUBLIC_URL = "https://soulstream.example.test";
const SESSION_ID = "link-public-session";
const KEY = "ssxl_aaaaaaaaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER_KEY = "ssxl_cccccccccccccccccccccc_ddddddddddddddddddddddddddddddddddddddddddd";
const WEBHOOK_KEY = "ssxw_eeeeeeeeeeeeeeeeeeeeee_fffffffffffffffffffffffffffffffffffffffffff";

function linkGrant(overrides: Partial<ExternalAccessGrant> = {}): ExternalAccessGrant {
  return {
    id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
    kind: "link",
    owner_email: "owner@example.com",
    label: "외부 링크",
    target_session_id: SESSION_ID,
    permissions: ["send", "read_own", "read_history", "control"],
    auth_mode: "key",
    key_hash: hashExternalAccessKey(KEY),
    signing_secret: null,
    preamble: null,
    expires_at: new Date("2026-12-01T00:00:00.000Z"),
    revoked_at: null,
    created_at: new Date("2026-11-01T00:00:00.000Z"),
    last_used_at: null,
    ...overrides,
  };
}

function statusFixture(overrides: Partial<ExternalRequestStatus> = {}): ExternalRequestStatus {
  return {
    request_id: "request-1",
    status: "accepted",
    replies: [],
    session: { state: "running" },
    ...overrides,
  };
}

type FakeState = {
  resolveGrant: ReturnType<typeof vi.fn>;
  admit: ReturnType<typeof vi.fn>;
  readStatus: ReturnType<typeof vi.fn>;
  touchLastUsedAt: ReturnType<typeof vi.fn>;
  loadHistory: ReturnType<typeof vi.fn>;
  stopSession: ReturnType<typeof vi.fn>;
  bucket: ExternalAccessTokenBucket;
  eventHub: RuntimeSessionEventHub;
  replySignal: ExternalReplySignal;
};

function createFakeState(overrides: Partial<FakeState> = {}): FakeState {
  const grant = linkGrant();
  return {
    resolveGrant: vi.fn(async (rawKey: string) =>
      rawKey === KEY
        ? { ok: true as const, grant }
        : { ok: false as const, code: "unauthorized" as const, status: 401 as const }),
    admit: vi.fn(async (_grant: ExternalAccessGrant, input: { text: string; request_id?: string }) => ({
      ok: true as const,
      request_id: input.request_id ?? "generated-request",
      status: "accepted" as const,
    })),
    readStatus: vi.fn(async (): Promise<ReadExternalRequestStatusResult> => ({
      ok: true,
      status: statusFixture(),
    })),
    touchLastUsedAt: vi.fn(async () => {}),
    loadHistory: vi.fn(async () => ({
      items: [
        {
          item: {
            id: "0:1",
            kind: "user",
            text: "안녕하세요",
            at: "2026-11-01T00:00:00.000Z",
            attachments: [],
            sender: { kind: "external", label: "외부 링크" },
          },
        },
        {
          item: {
            id: "0:2",
            kind: "assistant",
            text: "네.",
            at: "2026-11-01T00:00:01.000Z",
            attachments: [],
          },
        },
        {
          item: {
            id: "0:3",
            kind: "tool",
            text: "tool",
            at: "2026-11-01T00:00:02.000Z",
            attachments: [],
          },
        },
      ],
    })),
    stopSession: vi.fn(async () => "stopped" as const),
    bucket: new ExternalAccessTokenBucket(),
    eventHub: new RuntimeSessionEventHub(),
    replySignal: new ExternalReplySignal(),
    ...overrides,
  };
}

function createApp(
  state: FakeState,
  extra: Partial<ExternalAccessPublicRouteOptions> = {},
): FastifyInstance {
  const app = Fastify();
  registerExternalAccessPublicRoutes(app, {
    sql: (async () => [{ display_name: "링크 대상", agent_id: "roselin" }]) as never,
    publicUrl: `${PUBLIC_URL}/`,
    grants: {
      resolveGrant: state.resolveGrant as never,
      touchLastUsedAt: state.touchLastUsedAt as never,
    },
    inputService: {
      admit: state.admit as never,
      readExternalRequestStatus: state.readStatus as never,
    },
    history: { load: state.loadHistory as never },
    stopSession: state.stopSession as never,
    tokenBucket: state.bucket,
    eventHub: state.eventHub,
    replySignal: state.replySignal,
    ...extra,
  });
  return app;
}

function expectLinkHeaders(response: {
  headers: Record<string, unknown>;
}): void {
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["referrer-policy"]).toBe("no-referrer");
  expect(response.headers["access-control-allow-origin"]).toBeUndefined();
}

describe("external access public link routes", () => {
  it("serves text guidance by default and JSON on Accept, with only allowed actions", async () => {
    const state = createFakeState();
    const app = createApp(state);
    try {
      const text = await app.inject({ method: "GET", url: `/x/${KEY}` });
      expect(text.statusCode).toBe(200);
      expectLinkHeaders(text);
      expect(text.headers["content-type"]).toContain("text/plain");
      expect(text.body).toContain("링크 대상");
      expect(text.body).toContain(`${PUBLIC_URL}/x/${KEY}/messages`);
      expect(text.body).toContain("-H 'Content-Type: application/json'");
      expect(text.body).toContain(`${PUBLIC_URL}/x/${KEY}/messages/<request_id>?wait=25`);
      expect(text.body).toContain(`${PUBLIC_URL}/x/${KEY}/history?limit=50`);
      expect(text.body).toContain(`${PUBLIC_URL}/x/${KEY}/stop`);
      expect(state.touchLastUsedAt).not.toHaveBeenCalled();

      const json = await app.inject({
        method: "GET",
        url: `/x/${KEY}`,
        headers: { accept: "application/json" },
      });
      expect(json.statusCode).toBe(200);
      expect(json.headers["content-type"]).toContain("application/json");
      const body = json.json() as { permissions: string[]; actions: Array<{ name: string }> };
      expect(body.permissions).toEqual(["send", "read_own", "read_history", "control"]);
      expect(body.actions.map((action) => action.name)).toEqual([
        "send",
        "read_own",
        "read_history",
        "control",
      ]);

      const limitedGrant = linkGrant({ permissions: ["send"] });
      const limited = createApp(createFakeState({
        resolveGrant: vi.fn(async () => ({ ok: true as const, grant: limitedGrant })),
      }));
      try {
        const limitedResponse = await limited.inject({ method: "GET", url: `/x/${KEY}` });
        expect(limitedResponse.statusCode).toBe(200);
        expect(limitedResponse.body).toContain("허용된 동작: send");
        expect(limitedResponse.body).not.toContain("/history");
        expect(limitedResponse.body).not.toContain("/stop");
        expect(limitedResponse.body).not.toContain("wait=25");
      } finally {
        await limited.close();
      }
    } finally {
      await app.close();
    }
  });

  it("answers every credential failure with one 401 body and checks kind before permission", async () => {
    const state = createFakeState();
    const app = createApp(state);
    try {
      const wrongKey = await app.inject({ method: "GET", url: `/x/${OTHER_KEY}` });
      expect(wrongKey.statusCode).toBe(401);
      expectLinkHeaders(wrongKey);
      const unauthorizedBody = wrongKey.json();

      const webhookGrant = linkGrant({
        kind: "inbound_webhook",
        key_hash: hashExternalAccessKey(WEBHOOK_KEY),
      });
      const webhookState = createFakeState({
        resolveGrant: vi.fn(async () => ({ ok: true as const, grant: webhookGrant })),
      });
      const webhookApp = createApp(webhookState);
      try {
        const paths: Array<{
          method: "GET" | "POST";
          url: string;
          payload?: Record<string, unknown>;
        }> = [
          { method: "GET", url: `/x/${WEBHOOK_KEY}` },
          { method: "POST", url: `/x/${WEBHOOK_KEY}/messages`, payload: { text: "안녕" } },
          { method: "GET", url: `/x/${WEBHOOK_KEY}/messages/request-1?wait=1` },
          { method: "GET", url: `/x/${WEBHOOK_KEY}/history` },
          { method: "POST", url: `/x/${WEBHOOK_KEY}/stop` },
        ];
        for (const path of paths) {
          const response = path.payload === undefined
            ? await app.inject({ method: path.method, url: path.url })
            : await app.inject({ method: path.method, url: path.url, payload: path.payload });
          expect(response.statusCode, path.url).toBe(401);
          expect(response.json(), path.url).toEqual(unauthorizedBody);
          expectLinkHeaders(response);
        }
        expect(webhookState.admit).not.toHaveBeenCalled();
        expect(webhookState.readStatus).not.toHaveBeenCalled();
        expect(webhookState.stopSession).not.toHaveBeenCalled();
        expect(webhookState.touchLastUsedAt).not.toHaveBeenCalled();
      } finally {
        await webhookApp.close();
      }

      // The body names no internal detail, key, or path.
      expect(JSON.stringify(unauthorizedBody)).not.toContain(OTHER_KEY);
      expect(JSON.stringify(unauthorizedBody)).not.toContain("/x/");
    } finally {
      await app.close();
    }
  });

  it("refuses actions the link is not allowed to perform with one 403 body", async () => {
    const sendOnly = createApp(createFakeState({
      resolveGrant: vi.fn(async () => ({
        ok: true as const,
        grant: linkGrant({ permissions: ["send"] }),
      })),
    }));
    try {
      for (const request of [
        { method: "GET" as const, url: `/x/${KEY}/messages/request-1` },
        { method: "GET" as const, url: `/x/${KEY}/history` },
        { method: "POST" as const, url: `/x/${KEY}/stop` },
      ]) {
        const response = await sendOnly.inject(request);
        expect(response.statusCode, request.url).toBe(403);
        expect(response.json()).toEqual({
          error: { code: "forbidden", message: "Action not permitted" },
        });
        expectLinkHeaders(response);
      }
      // send is allowed.
      const send = await sendOnly.inject({
        method: "POST",
        url: `/x/${KEY}/messages`,
        payload: { text: "안녕" },
      });
      expect(send.statusCode).toBe(202);
    } finally {
      await sendOnly.close();
    }

    const readOnly = createApp(createFakeState({
      resolveGrant: vi.fn(async () => ({
        ok: true as const,
        grant: linkGrant({ permissions: ["read_own"] }),
      })),
    }));
    try {
      const response = await readOnly.inject({
        method: "POST",
        url: `/x/${KEY}/messages`,
        payload: { text: "안녕" },
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await readOnly.close();
    }
  });

  it("accepts a strict JSON body and maps admission outcomes", async () => {
    const state = createFakeState();
    const app = createApp(state);
    try {
      const accepted = await app.inject({
        method: "POST",
        url: `/x/${KEY}/messages`,
        headers: { cookie: "session=ignored", authorization: "Bearer ignored" },
        payload: { text: "  안녕하세요  ", request_id: "my-request-1" },
      });
      expect(accepted.statusCode).toBe(202);
      expect(accepted.json()).toEqual({
        request_id: "my-request-1",
        status: "accepted",
      });
      expectLinkHeaders(accepted);
      expect(state.admit).toHaveBeenCalledWith(
        expect.objectContaining({ id: linkGrant().id }),
        { text: "  안녕하세요  ", request_id: "my-request-1" },
      );

      const extraKey = await app.inject({
        method: "POST",
        url: `/x/${KEY}/messages`,
        payload: { text: "안녕", unexpected: true },
      });
      expect(extraKey.statusCode).toBe(400);

      const empty = await app.inject({
        method: "POST",
        url: `/x/${KEY}/messages`,
        payload: { text: "   " },
      });
      expect(empty.statusCode).toBe(400);
      expect(empty.json()).toEqual({
        error: { code: "empty_text", message: "text must not be empty" },
      });

      const invalidJson = await app.inject({
        method: "POST",
        url: `/x/${KEY}/messages`,
        headers: { "content-type": "application/json" },
        payload: "{",
      });
      expect(invalidJson.statusCode).toBe(400);
      expectLinkHeaders(invalidJson);

      const wrongMediaType = await app.inject({
        method: "POST",
        url: `/x/${KEY}/messages`,
        headers: { "content-type": "application/octet-stream" },
        payload: "binary",
      });
      expect(wrongMediaType.statusCode).toBe(415);
      expect(wrongMediaType.json()).toEqual({
        error: {
          code: "unsupported_media_type",
          message: "Content-Type must be application/json",
        },
      });

      const tooLarge = await app.inject({
        method: "POST",
        url: `/x/${KEY}/messages`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ text: "x".repeat(300 * 1024) }),
      });
      expect(tooLarge.statusCode).toBe(413);
      expect(tooLarge.json()).toEqual({
        error: { code: "payload_too_large", message: "Request body exceeds 256KiB" },
      });

      const outcomes: Array<[AdmitExternalInputResult, number, string | null]> = [
        [{ ok: false, reason: "conflict" }, 409, null],
        [{ ok: false, reason: "invalid_request_id" }, 400, null],
        [{ ok: false, reason: "rate_limited", retry_after_seconds: 12 }, 429, "12"],
      ];
      for (const [outcome, status, retryAfter] of outcomes) {
        const outcomeState = createFakeState({ admit: vi.fn(async () => outcome) });
        const outcomeApp = createApp(outcomeState);
        try {
          const response = await outcomeApp.inject({
            method: "POST",
            url: `/x/${KEY}/messages`,
            payload: { text: "안녕" },
          });
          expect(response.statusCode, JSON.stringify(outcome)).toBe(status);
          expectLinkHeaders(response);
          if (retryAfter !== null) {
            expect(response.headers["retry-after"]).toBe(retryAfter);
          }
        } finally {
          await outcomeApp.close();
        }
      }
    } finally {
      await app.close();
    }
  });

  it("returns status shapes, validates wait, and holds until a signal changes the status", async () => {
    let reads = 0;
    const changed = statusFixture({ session: { state: "idle" } });
    const state = createFakeState({
      readStatus: vi.fn(async (_grant: ExternalAccessGrant, requestId: string) => {
        if (requestId === "missing") {
          return { ok: false as const, reason: "not_found" as const };
        }
        reads += 1;
        return { ok: true as const, status: reads === 1 ? statusFixture() : changed };
      }),
    });
    const app = createApp(state);
    try {
      const simple = await app.inject({ method: "GET", url: `/x/${KEY}/messages/request-1` });
      expect(simple.statusCode).toBe(200);
      expect(simple.json()).toEqual(statusFixture());
      expect(state.touchLastUsedAt).toHaveBeenCalledTimes(1);

      for (const wait of ["abc", "-1", "26", "1.5"]) {
        const invalid = await app.inject({
          method: "GET",
          url: `/x/${KEY}/messages/request-1?wait=${wait}`,
        });
        expect(invalid.statusCode, wait).toBe(400);
        expectLinkHeaders(invalid);
      }

      const notFound = await app.inject({
        method: "GET",
        url: `/x/${KEY}/messages/missing`,
      });
      expect(notFound.statusCode).toBe(404);
      expect(notFound.json()).toEqual({
        error: { code: "not_found", message: "Request not found" },
      });

      reads = 0;
      const startedAt = Date.now();
      const pending = app.inject({
        method: "GET",
        url: `/x/${KEY}/messages/request-1?wait=25`,
      });
      setTimeout(() => state.replySignal.notify(linkGrant().id, "request-1"), 50);
      const woken = await pending;
      const elapsed = Date.now() - startedAt;
      expect(woken.statusCode).toBe(200);
      expect(woken.json()).toEqual(changed);
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(5_000);
      // The wait woke on the signal; the re-read happened at most once a second.
      expect(reads).toBeLessThanOrEqual(3);
      expect(state.touchLastUsedAt).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it("keeps every long-poll re-read at least one second apart however many signals arrive", async () => {
    vi.useFakeTimers();
    try {
      const readTimes: number[] = [];
      const state = createFakeState({
        // A real status read takes time. Signals that land during these 50ms
        // must not let the next read start before the one-second interval.
        readStatus: vi.fn(async () => {
          readTimes.push(Date.now());
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { ok: true as const, status: statusFixture() };
        }),
      });
      const app = createApp(state);
      try {
        const pending = app.inject({
          method: "GET",
          url: `/x/${KEY}/messages/request-1?wait=3`,
        });
        const repeated = setInterval(
          () => state.replySignal.notify(linkGrant().id, "request-1"),
          10,
        );
        try {
          // The route reads once before it starts holding; the extra 200ms
          // covers that read and the final hold read.
          await vi.advanceTimersByTimeAsync(3_200);
        } finally {
          clearInterval(repeated);
        }
        const response = await pending;
        expect(response.statusCode).toBe(200);
        // The first read is the route's own; the rest happen while held.
        const holdReads = readTimes.slice(1);
        expect(holdReads.length).toBeLessThanOrEqual(4);
        expect(holdReads.length).toBeGreaterThan(0);
        for (let index = 1; index < readTimes.length; index += 1) {
          expect(readTimes[index]! - readTimes[index - 1]!).toBeGreaterThanOrEqual(1_000);
        }
      } finally {
        await app.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hold for terminal status and re-checks the link before sending data", async () => {
    const terminal = createApp(createFakeState({
      readStatus: vi.fn(async () => ({
        ok: true as const,
        status: statusFixture({ status: "completed", outcome: "replied" }),
      })),
    }));
    try {
      const startedAt = Date.now();
      const response = await terminal.inject({
        method: "GET",
        url: `/x/${KEY}/messages/request-1?wait=25`,
      });
      expect(response.statusCode).toBe(200);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(response.json()).toMatchObject({ status: "completed", outcome: "replied" });
    } finally {
      await terminal.close();
    }

    let resolveCalls = 0;
    const expiring = createApp(createFakeState({
      resolveGrant: vi.fn(async () => {
        resolveCalls += 1;
        return resolveCalls === 1
          ? { ok: true as const, grant: linkGrant() }
          : { ok: false as const, code: "unauthorized" as const, status: 401 as const };
      }),
    }));
    try {
      const response = await expiring.inject({
        method: "GET",
        url: `/x/${KEY}/messages/request-1?wait=1`,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: { code: "unauthorized", message: "Unauthorized" },
      });
      expect(resolveCalls).toBe(2);
    } finally {
      await expiring.close();
    }
  });

  it("serves only user and assistant history items with before and limit", async () => {
    const state = createFakeState();
    state.loadHistory = vi.fn(async () => ({
      items: [
        { item: { id: "0:1", kind: "user", text: "첫째", at: "2026-11-01T00:00:00.000Z", attachments: [] } },
        { item: { id: "0:2", kind: "assistant", text: "둘째", at: "2026-11-01T00:00:01.000Z", attachments: [] } },
        { item: { id: "0:3", kind: "user", text: "셋째", at: "2026-11-01T00:00:02.000Z", attachments: [], sender: { kind: "external", label: "외부 링크" } } },
        { item: { id: "0:4", kind: "error", text: "오류", at: "2026-11-01T00:00:03.000Z", attachments: [] } },
        { item: { id: "0:5", kind: "notice", text: "알림", at: "2026-11-01T00:00:04.000Z", attachments: [] } },
        { item: { id: "0:6", kind: "assistant", text: "마지막", at: "2026-11-01T00:00:05.000Z", attachments: [] } },
      ],
    }));
    const app = createApp(state);
    try {
      const all = await app.inject({ method: "GET", url: `/x/${KEY}/history` });
      expect(all.statusCode).toBe(200);
      const body = all.json() as {
        items: Array<{ id: string; role: string; text: string; at: string; sender?: unknown }>;
        next_before?: string;
      };
      expect(body.items.map((item) => item.text)).toEqual(["첫째", "둘째", "셋째", "마지막"]);
      expect(body.items[2]?.sender).toEqual({ kind: "external", label: "외부 링크" });
      expect(body.items[0]).not.toHaveProperty("sender");
      expect(JSON.stringify(body)).not.toContain("attachments");
      expect(body.next_before).toBeUndefined();

      const page = await app.inject({
        method: "GET",
        url: `/x/${KEY}/history?limit=2&before=0:6`,
      });
      expect(page.statusCode).toBe(200);
      expect(page.json()).toMatchObject({
        items: [
          { id: "0:2", role: "assistant", text: "둘째" },
          { id: "0:3", role: "user", text: "셋째" },
        ],
        next_before: "0:2",
      });

      for (const query of ["before=unknown", "limit=0", "limit=51", "limit=abc"]) {
        const invalid = await app.inject({ method: "GET", url: `/x/${KEY}/history?${query}` });
        expect(invalid.statusCode, query).toBe(400);
      }
      expect(state.loadHistory).toHaveBeenCalledWith({
        session_id: SESSION_ID,
        first_input_is_initial_instruction: false,
        creation_request: null,
        notices: [],
      });
    } finally {
      await app.close();
    }
  });

  it("maps stop outcomes and returns a fixed 404 for unmatched /x paths", async () => {
    const outcomes: Array<[string, number]> = [
      ["stopped", 200],
      ["not_running", 409],
      ["unavailable", 503],
    ];
    for (const [outcome, status] of outcomes) {
      const state = createFakeState({ stopSession: vi.fn(async () => outcome) });
      const app = createApp(state);
      try {
        const response = await app.inject({ method: "POST", url: `/x/${KEY}/stop` });
        expect(response.statusCode, outcome).toBe(status);
        expectLinkHeaders(response);
        if (status === 200) {
          expect(response.json()).toEqual({ ok: true });
          expect(state.touchLastUsedAt).toHaveBeenCalledTimes(1);
        }
        if (status === 409) {
          expect(response.json()).toEqual({
            error: { code: "not_running", message: "Session is not running" },
          });
        }
        if (status === 503) {
          expect(response.json()).toEqual({
            error: {
              code: "control_unavailable",
              message: "Session control is temporarily unavailable",
            },
          });
        }
      } finally {
        await app.close();
      }
    }

    const throwing = createApp(createFakeState({
      stopSession: vi.fn(async () => { throw new Error("transport blew up"); }),
    }));
    try {
      const response = await throwing.inject({ method: "POST", url: `/x/${KEY}/stop` });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("transport blew up");
    } finally {
      await throwing.close();
    }

    const state = createFakeState();
    const app = createApp(state);
    try {
      const missing: Array<{ method: "GET" | "POST" | "DELETE"; url: string }> = [
        { method: "GET", url: `/x/${KEY}/unknown` },
        { method: "POST", url: `/x/${KEY}/unknown` },
        { method: "GET", url: "/x" },
        { method: "DELETE", url: `/x/${KEY}/messages` },
      ];
      for (const request of missing) {
        const response = await app.inject(request);
        expect(response.statusCode, `${request.method} ${request.url}`).toBe(404);
        expect(response.json()).toEqual({
          error: { code: "not_found", message: "Not found" },
        });
        expectLinkHeaders(response);
      }
    } finally {
      await app.close();
    }
  });

  it("takes one read token per HTTP request, never on hold re-reads", async () => {
    const bucket = new ExternalAccessTokenBucket();
    const take = vi.spyOn(bucket, "take");
    let reads = 0;
    const state = createFakeState({
      bucket,
      readStatus: vi.fn(async (_grant, _requestId, options?: { consumeRate?: boolean }) => {
        if (options?.consumeRate !== false) {
          bucket.take(`read:${linkGrant().id}`, EXTERNAL_READ_RATE_PER_MINUTE);
        }
        reads += 1;
        return reads === 1
          ? { ok: true as const, status: statusFixture() }
          : { ok: true as const, status: statusFixture({ replies: [{ id: "r1", text: "회신", at: "2026-11-01T00:00:00.000Z" }] }) };
      }),
    });
    const app = createApp(state);
    try {
      const pending = app.inject({ method: "GET", url: `/x/${KEY}/messages/request-1?wait=25` });
      setTimeout(() => state.replySignal.notify(linkGrant().id, "request-1"), 50);
      const response = await pending;
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ replies: [{ id: "r1" }] });
      expect(take).toHaveBeenCalledTimes(1);
      // Send tokens use the same bucket instance and key rule.
      const stop = await app.inject({ method: "POST", url: `/x/${KEY}/stop` });
      expect(stop.statusCode).toBe(200);
      expect(take).toHaveBeenCalledWith(`send:${linkGrant().id}`, EXTERNAL_SEND_RATE_PER_MINUTE);
    } finally {
      await app.close();
    }
  });

  it("returns 429 with Retry-After when the read bucket is exhausted", async () => {
    const state = createFakeState({
      bucket: new ExternalAccessTokenBucket({ now: () => 0 }),
    });
    const app = createApp(state);
    try {
      for (let attempt = 0; attempt < EXTERNAL_READ_RATE_PER_MINUTE; attempt += 1) {
        const response = await app.inject({ method: "GET", url: `/x/${KEY}` });
        expect(response.statusCode).toBe(200);
      }
      const limited = await app.inject({ method: "GET", url: `/x/${KEY}` });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("1");
      expect(limited.json()).toEqual({
        error: { code: "rate_limited", message: "Too many requests" },
      });
      expectLinkHeaders(limited);
    } finally {
      await app.close();
    }
  });
});
