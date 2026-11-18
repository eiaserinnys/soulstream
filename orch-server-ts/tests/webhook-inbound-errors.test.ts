/**
 * card #1458 — an exception in the inbound webhook route answers 503 with the
 * fixed error shape and the log carries only a safe classification. The body,
 * key, signature and the error message/detail must never reach the log.
 */
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { parseOrchServerConfig } from "../src/config.js";
import type { ExternalAccessGrant } from
  "../src/external_access/external_access_grant_repository.js";
import type { ExternalInputService } from "../src/external_access/external_input_service.js";

const SECRET = "whsec_route_secret_value";
const RAW_KEY = "ssxw_0123456789abcdefghijkl_secret-key-material";
const BODY = "비밀 본문 내용";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "test-token",
});

function grant(): ExternalAccessGrant {
  return {
    id: "0f6c2c9a-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
    kind: "inbound_webhook",
    owner_email: "owner@example.com",
    label: "오류 웹훅",
    target_session_id: "target-session",
    permissions: ["send", "read_own"],
    auth_mode: "key",
    key_hash: "a".repeat(64),
    signing_secret: null,
    preamble: null,
    expires_at: null,
    revoked_at: null,
    created_at: new Date("2026-11-01T00:00:00.000Z"),
    last_used_at: null,
  };
}

function captureLogger() {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      warn: (fields: Record<string, unknown>, message: string) => {
        lines.push(`${message} ${JSON.stringify(fields)}`);
      },
    },
  };
}

describe("inbound webhook route failures", () => {
  it("answers 503 without leaking the secret when admission throws", async () => {
    const capture = captureLogger();
    const service = {
      admit: async () => {
        throw Object.assign(new Error(`admission failed ${SECRET}`), {
          detail: SECRET,
        });
      },
      readExternalRequestStatus: async () => ({ ok: false, reason: "not_found" }),
    } as unknown as Pick<
      ExternalInputService,
      "admit" | "readExternalRequestStatus"
    >;
    const grants = {
      resolveInboundWebhookGrant: async () => ({ ok: true as const, grant: grant() }),
    };
    const app = createApp({
      config,
      inboundHookRoutes: { grants, service, logger: capture.logger },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/hooks/${grant().id}`,
      payload: BODY,
      headers: { authorization: `Bearer ${RAW_KEY}` },
    });

    expect(response.statusCode).toBe(503);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      error: { code: "unavailable", message: "Service unavailable" },
    });
    expect(capture.lines.length).toBeGreaterThan(0);
    for (const line of capture.lines) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain(RAW_KEY);
      expect(line).not.toContain(BODY);
    }
    await app.close();
  });

  it("logs only the SQLSTATE and constraint when the grant lookup fails", async () => {
    const capture = captureLogger();
    const grants = {
      resolveInboundWebhookGrant: async () => {
        throw Object.assign(
          new Error(`lookup failed for ${SECRET} and ${RAW_KEY}`),
          { code: "57P01", constraint: "external_access_grants_pkey" },
        );
      },
    };
    const service = {
      admit: async () => ({ ok: true, request_id: "unused", status: "accepted" }),
      readExternalRequestStatus: async () => ({ ok: false, reason: "not_found" }),
    } as unknown as Pick<
      ExternalInputService,
      "admit" | "readExternalRequestStatus"
    >;
    const app = createApp({
      config,
      inboundHookRoutes: { grants, service, logger: capture.logger },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/hooks/${grant().id}`,
      payload: BODY,
      headers: { authorization: `Bearer ${RAW_KEY}` },
    });

    expect(response.statusCode).toBe(503);
    const joined = capture.lines.join("\n");
    expect(joined).toContain("57P01");
    expect(joined).toContain("external_access_grants_pkey");
    expect(joined).not.toContain(SECRET);
    expect(joined).not.toContain(RAW_KEY);
    expect(joined).not.toContain(BODY);
    await app.close();
  });

  it("answers the same 404 for an unknown request in the read route", async () => {
    const service = {
      admit: async () => ({ ok: true, request_id: "unused", status: "accepted" }),
      readExternalRequestStatus: async () => ({ ok: false, reason: "not_found" }),
    } as unknown as Pick<
      ExternalInputService,
      "admit" | "readExternalRequestStatus"
    >;
    const grants = {
      resolveInboundWebhookGrant: async () => ({ ok: true as const, grant: grant() }),
    };
    const app = createApp({ config, inboundHookRoutes: { grants, service } });

    const missing = await app.inject({
      method: "GET",
      url: `/api/hooks/${grant().id}/requests/unknown`,
      headers: { authorization: `Bearer ${RAW_KEY}` },
    });
    const missingAgain = await app.inject({
      method: "GET",
      url: `/api/hooks/${grant().id}/requests/another`,
      headers: { authorization: `Bearer ${RAW_KEY}` },
    });
    expect(missing.statusCode).toBe(404);
    expect(missingAgain.json()).toEqual(missing.json());
    expect(missing.json()).toEqual({
      error: { code: "not_found", message: "Not found" },
    });
    await app.close();
  });
});
