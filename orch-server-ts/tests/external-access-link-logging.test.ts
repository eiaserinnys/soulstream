/**
 * card #1457 — the deployment condition for the public link surface: the link
 * key lives in the URL path, so no application log line may carry it.
 *
 * Two apps are built exactly like production except for the presence of the
 * dashboard 404 handler. Both have the operational Fastify options and logger,
 * the production auth guard, a non-empty CORS allowlist, and the root
 * multipart/form-data parser that attachment routes register. The same request
 * list runs on both: every line and every response body except the guidance
 * itself is searched for both synthetic keys' parts, and every `/x` response
 * must carry no `Access-Control-*` header.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createApp,
  parseOrchServerConfig,
} from "../src/index.js";
import { registerDashboardServing } from "../src/dashboard/dashboard_serving.js";
import {
  hashExternalAccessKey,
  type ExternalAccessGrant,
} from "../src/external_access/external_access_grant_repository.js";
import { ExternalAccessTokenBucket } from "../src/external_access/external_access_token_bucket.js";
import { ExternalReplySignal } from "../src/external_access/external_reply_signal.js";
import type { AdmitExternalInputResult } from "../src/external_access/external_input_service.js";
import type { ExternalAccessPublicRouteOptions } from "../src/external_access/public_link_routes.js";
import { registerMultipartFormParser } from "../src/http/multipart_form.js";
import { RuntimeSessionEventHub } from "../src/runtime/session_event_hub.js";

const productionConfig = parseOrchServerConfig({
  environment: "production",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "production-service-token",
});

const GRANT_PART = "G".repeat(22);
const SECRET_PART = "S".repeat(43);
const KEY = `ssxl_${GRANT_PART}_${SECRET_PART}`;
const WRONG_GRANT_PART = "W".repeat(22);
const WRONG_SECRET_PART = "R".repeat(43);
const WRONG_KEY = `ssxl_${WRONG_GRANT_PART}_${WRONG_SECRET_PART}`;
const ALL_PARTS = [
  KEY,
  GRANT_PART,
  SECRET_PART,
  WRONG_KEY,
  WRONG_GRANT_PART,
  WRONG_SECRET_PART,
];
const ALLOWED_ORIGIN = "https://app.example.test";

function linkGrant(permissions: ExternalAccessGrant["permissions"]): ExternalAccessGrant {
  return {
    id: "6f5e4d3c-2b1a-4f9e-8d7c-6b5a4f3e2d1c",
    kind: "link",
    owner_email: "owner@example.com",
    label: "로그 가림 링크",
    target_session_id: "logging-target-session",
    permissions,
    auth_mode: "key",
    key_hash: hashExternalAccessKey(KEY),
    signing_secret: null,
    preamble: null,
    expires_at: new Date("2026-12-01T00:00:00.000Z"),
    revoked_at: null,
    created_at: new Date("2026-11-01T00:00:00.000Z"),
    last_used_at: null,
  };
}

type InjectRequest = {
  method: "GET" | "POST" | "DELETE" | "OPTIONS";
  url: string;
  headers?: Record<string, string>;
  payload?: string | Record<string, unknown>;
};

type LogCapture = {
  stream: { write(message: string): void };
  raw(): string;
  records(): Array<Record<string, unknown>>;
};

function createLogCapture(): LogCapture {
  const chunks: string[] = [];
  return {
    stream: {
      write(message: string) {
        chunks.push(message);
      },
    },
    raw: () => chunks.join(""),
    records: (): Array<Record<string, unknown>> => chunks.join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

type Behavior = {
  resolveThrows: boolean;
  admitThrows: boolean;
};

function createPublicRouteOptions(behavior: Behavior): ExternalAccessPublicRouteOptions {
  const grant = linkGrant(["send", "read_own", "read_history"]);
  return {
    sql: (async () => [{ display_name: "로그 대상", agent_id: "roselin" }]) as never,
    publicUrl: "https://soulstream.example.test",
    grants: {
      resolveGrant: async (rawKey: string) => {
        if (behavior.resolveThrows) {
          // A database failure that carries the full key in its message must
          // never reach the log or the response body.
          throw new Error(`grant lookup failed for ${rawKey}`);
        }
        return rawKey === KEY
          ? { ok: true as const, grant }
          : { ok: false as const, code: "unauthorized" as const, status: 401 as const };
      },
      touchLastUsedAt: async () => {},
    },
    inputService: {
      admit: async (_grant, input) => {
        if (behavior.admitThrows) throw new Error("admit-explosion-marker");
        return await Promise.resolve({
          ok: true as const,
          request_id: input.request_id ?? "generated-request",
          status: "accepted" as const,
        } satisfies AdmitExternalInputResult);
      },
      readExternalRequestStatus: async () => ({
        ok: true as const,
        status: {
          request_id: "request-1",
          status: "completed" as const,
          outcome: "replied" as const,
          replies: [],
          session: { state: "idle" as const },
        },
      }),
    },
    history: { load: async () => ({ items: [] }) },
    stopSession: async () => "not_running",
    tokenBucket: new ExternalAccessTokenBucket(),
    eventHub: new RuntimeSessionEventHub(),
    replySignal: new ExternalReplySignal(),
  };
}

type Scenario = {
  name: string;
  request: InjectRequest;
  guidance?: boolean;
  expectedStatus: number;
  before?: (behavior: Behavior) => void;
  after?: (behavior: Behavior) => void;
};

function scenarios(): Scenario[] {
  return [
    {
      name: "guidance",
      request: { method: "GET", url: `/x/${KEY}` },
      guidance: true,
      expectedStatus: 200,
    },
    {
      name: "message accepted",
      request: {
        method: "POST",
        url: `/x/${KEY}/messages`,
        payload: { text: "안녕하세요", request_id: "log-1" },
      },
      expectedStatus: 202,
    },
    {
      name: "status read",
      request: { method: "GET", url: `/x/${KEY}/messages/log-1` },
      expectedStatus: 200,
    },
    {
      name: "history read",
      request: { method: "GET", url: `/x/${KEY}/history` },
      expectedStatus: 200,
    },
    {
      name: "wrong key",
      request: {
        method: "POST",
        url: `/x/${WRONG_KEY}/messages`,
        payload: { text: "안녕" },
      },
      expectedStatus: 401,
    },
    {
      name: "missing permission",
      request: { method: "POST", url: `/x/${KEY}/stop`, payload: {} },
      expectedStatus: 403,
    },
    {
      name: "unmatched GET",
      request: { method: "GET", url: `/x/${KEY}/unknown` },
      expectedStatus: 404,
    },
    {
      name: "unmatched POST",
      request: { method: "POST", url: `/x/${KEY}/unknown`, payload: {} },
      expectedStatus: 401,
    },
    {
      name: "unsupported method",
      request: { method: "DELETE", url: `/x/${KEY}/messages` },
      expectedStatus: 401,
    },
    {
      name: "preflight",
      request: {
        method: "OPTIONS",
        url: `/x/${KEY}/messages`,
        headers: {
          origin: ALLOWED_ORIGIN,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      },
      expectedStatus: 401,
    },
    {
      name: "json parse error",
      request: {
        method: "POST",
        url: `/x/${KEY}/messages`,
        headers: { "content-type": "application/json" },
        payload: "{",
      },
      expectedStatus: 400,
    },
    {
      name: "other content type",
      request: {
        method: "POST",
        url: `/x/${KEY}/messages`,
        headers: { "content-type": "application/octet-stream" },
        payload: "binary",
      },
      expectedStatus: 415,
    },
    {
      name: "multipart content type",
      request: {
        method: "POST",
        url: `/x/${KEY}/messages`,
        headers: { "content-type": "multipart/form-data; boundary=x" },
        payload: "--x--",
      },
      expectedStatus: 415,
    },
    {
      name: "plain text content type",
      request: {
        method: "POST",
        url: `/x/${KEY}/messages`,
        headers: { "content-type": "text/plain" },
        payload: "안녕",
      },
      expectedStatus: 415,
    },
    {
      name: "oversized body",
      request: {
        method: "POST",
        url: `/x/${KEY}/messages`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ text: "x".repeat(300 * 1024) }),
      },
      expectedStatus: 413,
    },
    {
      name: "malformed percent encoding",
      request: { method: "GET", url: `/x/${KEY}/%zz` },
      expectedStatus: 400,
    },
    {
      name: "grant lookup failure",
      request: { method: "GET", url: `/x/${KEY}` },
      expectedStatus: 500,
      before: (behavior) => {
        behavior.resolveThrows = true;
      },
      after: (behavior) => {
        behavior.resolveThrows = false;
      },
    },
    {
      name: "admission failure",
      request: {
        method: "POST",
        url: `/x/${KEY}/messages`,
        payload: { text: "안녕" },
      },
      expectedStatus: 500,
      before: (behavior) => {
        behavior.admitThrows = true;
      },
      after: (behavior) => {
        behavior.admitThrows = false;
      },
    },
  ];
}

async function runScenarioList(
  variant: "with-dashboard" | "without-dashboard",
  dashboardDir: string,
): Promise<void> {
  const capture = createLogCapture();
  const behavior: Behavior = { resolveThrows: false, admitThrows: false };
  const app = createApp({
    config: productionConfig,
    logDestination: capture.stream,
    productionAuth: {
      resolveTokenAccess: async (request) => request.headers["x-echo-token"] === "echo"
        ? { ok: true } as never
        : {
            ok: false as const,
            statusCode: 401 as const,
            detail: "Authorization header required",
          },
      nodeCredentials: null,
    },
    corsAllowedOrigins: [ALLOWED_ORIGIN],
    externalAccessPublicRoutes: createPublicRouteOptions(behavior),
  });
  const responses: Array<{ body: string; url: string; guidance?: boolean }> = [];
  try {
    // The production root parser registered by attachment routes. The /x
    // plugin inherits it and removes it in its own scope; this echo route
    // proves the root parser itself is still active.
    registerMultipartFormParser(app);
    app.post("/logging/multipart-echo", async (request) => ({
      buffer: Buffer.isBuffer(request.body),
    }));
    if (variant === "with-dashboard") {
      expect(await registerDashboardServing(app, { dashboardDir })).toBe(true);
    }
    await app.ready();

    const echo = await app.inject({
      method: "POST",
      url: "/logging/multipart-echo",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "x-echo-token": "echo",
      },
      payload: "--x--",
    });
    expect(echo.statusCode, echo.body).toBe(200);
    expect(echo.json()).toEqual({ buffer: true });

    for (const scenario of scenarios()) {
      scenario.before?.(behavior);
      const response = scenario.request.payload === undefined
        ? await app.inject({
            method: scenario.request.method,
            url: scenario.request.url,
            ...(scenario.request.headers === undefined
              ? {}
              : { headers: scenario.request.headers }),
          })
        : await app.inject({
            method: scenario.request.method,
            url: scenario.request.url,
            ...(scenario.request.headers === undefined
              ? {}
              : { headers: scenario.request.headers }),
            payload: scenario.request.payload,
          });
      scenario.after?.(behavior);
      responses.push({
        body: response.body,
        url: scenario.request.url,
        guidance: scenario.guidance === true,
      });
      expect(response.statusCode, `${variant} ${scenario.name}: ${response.body}`)
        .toBe(scenario.expectedStatus);
      const corsHeaders = Object.keys(response.headers)
        .filter((header) => header.toLowerCase().startsWith("access-control-"));
      expect(corsHeaders, `${variant} ${scenario.name}`).toEqual([]);
    }

    const raw = capture.raw();
    for (const part of ALL_PARTS) {
      expect(raw, `${variant} log leaked ${part}`).not.toContain(part);
    }
    for (const response of responses) {
      if (response.guidance === true) continue;
      for (const part of ALL_PARTS) {
        expect(response.body, `${variant} ${response.url} leaked ${part}`)
          .not.toContain(part);
      }
    }
    // The failure messages themselves never reach the log.
    expect(raw).not.toContain("grant lookup failed");
    expect(raw).not.toContain("admit-explosion-marker");

    const records = capture.records();
    expect(records.some((record) => record.path === "/x/:key")).toBe(true);
    expect(records.some((record) => record.path === "/x/:redacted")).toBe(true);
    for (const record of records) {
      expect(JSON.stringify(record)).not.toContain(GRANT_PART);
      expect(JSON.stringify(record)).not.toContain(SECRET_PART);
    }
  } finally {
    await app.close();
  }
}

describe("external access link request logging", () => {
  let dashboardDir: string;

  beforeAll(async () => {
    dashboardDir = await mkdtemp(join(tmpdir(), "soulstream-dashboard-"));
    await mkdir(join(dashboardDir, "assets"), { recursive: true });
    await writeFile(join(dashboardDir, "index.html"), "<html>dashboard</html>");
  });

  afterAll(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(dashboardDir, { recursive: true, force: true });
  });

  it("runs the same request list on the app with a dashboard 404 handler", async () => {
    await runScenarioList("with-dashboard", dashboardDir);
  });

  it("runs the same request list on the app without a dashboard 404 handler", async () => {
    await runScenarioList("without-dashboard", dashboardDir);
  });

  it("applies the same redaction wherever a request object is logged", async () => {
    const capture = createLogCapture();
    const app = createApp({
      config: productionConfig,
      logDestination: capture.stream,
      externalAccessPublicRoutes: createPublicRouteOptions({
        resolveThrows: false,
        admitThrows: false,
      }),
    });
    try {
      app.get("/logging/echo", async (request) => {
        request.log.info({
          req: { method: "GET", url: `/x/${KEY}`, hostname: "probe", ip: "127.0.0.1" },
        }, "request serializer probe");
        request.log.info({ req: request }, "non-external serializer probe");
        return { ok: true };
      });
      await app.ready();
      const response = await app.inject({
        method: "GET",
        url: "/logging/echo?probe=plain",
      });
      expect(response.statusCode, response.body).toBe(200);
      const guidanceResponse = await app.inject({ method: "GET", url: `/x/${KEY}` });
      expect(guidanceResponse.statusCode).toBe(200);

      const records = capture.records();
      const externalProbe = records.find((record) => record.msg === "request serializer probe");
      expect(externalProbe).toMatchObject({
        req: { method: "GET", url: "/x/:redacted" },
      });
      const plainProbe = records.find((record) => record.msg === "non-external serializer probe");
      expect(plainProbe).toMatchObject({
        req: { method: "GET", url: "/logging/echo?probe=plain" },
      });
      expect(capture.raw()).not.toContain(SECRET_PART);
    } finally {
      await app.close();
    }
  });
});
