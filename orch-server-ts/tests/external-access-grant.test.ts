/**
 * card #1457 — grant resolution is the single entry point of every external
 * request: the key re-reads the row each time, any credential failure is the
 * same 401, and a missing permission is 403.
 */
import { describe, expect, it, vi } from "vitest";

import { SERVICE_CALLER } from "../src/auth/service_caller.js";
import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import {
  buildExternalAccessKey,
  ExternalAccessGrantRepository,
  hashExternalAccessKey,
  type ExternalAccessGrant,
  type ExternalGrantIssuerAuthorizer,
} from "../src/external_access/external_access_grant_repository.js";
import { SessionResourceAccessError } from
  "../src/session/session_resource_access.js";

const OWNER_EMAIL = "owner@example.com";
const GRANT_ID = "3f0e8a1c-9b2d-4c5e-8f6a-7b8c9d0e1f2a";
const TARGET_SESSION = "session-target";

const LIVE_KEY = buildExternalAccessKey(GRANT_ID, "link");

function liveKey(): string {
  return LIVE_KEY;
}

function grantRow(
  overrides: Partial<ExternalAccessGrant> = {},
): ExternalAccessGrant & { target_session_exists: boolean } {
  return {
    id: GRANT_ID,
    kind: "link",
    owner_email: OWNER_EMAIL,
    label: "테스트 링크",
    target_session_id: TARGET_SESSION,
    permissions: ["send", "read_own"],
    auth_mode: "key",
    key_hash: hashExternalAccessKey(liveKey()),
    signing_secret: null,
    preamble: null,
    expires_at: new Date("2026-12-01T00:00:00.000Z"),
    revoked_at: null,
    created_at: new Date("2026-11-01T00:00:00.000Z"),
    last_used_at: null,
    target_session_exists: true,
    ...overrides,
  };
}

function fakeGrantSql(rows: Array<ExternalAccessGrant & { target_session_exists: boolean }>): {
  sql: SqlClient;
  queries: Array<{ values: unknown[] }>;
} {
  const queries: Array<{ values: unknown[] }> = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ values });
    return Promise.resolve(rows);
  };
  return { sql: tag as unknown as SqlClient, queries };
}

function createRepository(input: {
  row?: (ExternalAccessGrant & { target_session_exists: boolean }) | null;
  authorizeUser?: ExternalGrantIssuerAuthorizer;
  requireSessionAccess?: (input: {
    request: unknown;
    sessionId: string;
    accessEmail?: string | null;
  }) => Promise<void>;
} = {}) {
  const rows = input.row === null ? [] : [input.row ?? grantRow()];
  const { sql, queries } = fakeGrantSql(rows);
  const authorizeUser = vi.fn(input.authorizeUser ?? (async () => null));
  const requireSessionAccess = vi.fn(input.requireSessionAccess ?? (async () => {}));
  const repository = new ExternalAccessGrantRepository({
    sql,
    authorizeUser,
    requireSessionAccess,
    now: () => new Date("2026-11-18T12:00:00.000Z"),
  });
  return { repository, queries, authorizeUser, requireSessionAccess };
}

describe("resolveGrant", () => {
  it("resolves a live key and re-reads the grant on every call", async () => {
    const { repository, queries } = createRepository();
    const key = liveKey();

    const first = await repository.resolveGrant(key, "send");
    const second = await repository.resolveGrant(key, "send");

    expect(first.ok && first.grant.id).toBe(GRANT_ID);
    expect(second.ok).toBe(true);
    // 캐시하지 않는다: 호출마다 grant 행을 다시 읽는다.
    expect(queries).toHaveLength(2);
  });

  it("answers every credential failure with the same unauthorized", async () => {
    const wrongKey = buildExternalAccessKey(GRANT_ID, "link");
    const wrongKeyResult = await createRepository()
      .repository.resolveGrant(wrongKey, "send");
    expect(wrongKeyResult).toEqual({
      ok: false,
      code: "unauthorized",
      status: 401,
    });

    const revoked = await createRepository({
      row: grantRow({ revoked_at: new Date("2026-11-17T00:00:00.000Z") }),
    }).repository.resolveGrant(liveKey(), "send");
    expect(revoked).toEqual({ ok: false, code: "unauthorized", status: 401 });

    const expired = await createRepository({
      row: grantRow({ expires_at: new Date("2026-11-18T11:59:59.000Z") }),
    }).repository.resolveGrant(liveKey(), "send");
    expect(expired).toEqual({ ok: false, code: "unauthorized", status: 401 });

    const disallowedIssuer = await createRepository({
      authorizeUser: async () => "no_user",
    }).repository.resolveGrant(liveKey(), "send");
    expect(disallowedIssuer).toEqual({ ok: false, code: "unauthorized", status: 401 });
  });

  it("checks the target session ACL as the grant owner", async () => {
    const { repository, requireSessionAccess } = createRepository({
      requireSessionAccess: async () => {
        throw new SessionResourceAccessError(
          "SESSION_ACCESS_DENIED",
          "Folder access denied",
          403,
        );
      },
    });

    const result = await repository.resolveGrant(liveKey(), "send");

    expect(result).toEqual({ ok: false, code: "unauthorized", status: 401 });
    expect(requireSessionAccess).toHaveBeenCalledWith({
      request: SERVICE_CALLER,
      sessionId: TARGET_SESSION,
      accessEmail: OWNER_EMAIL,
    });
  });

  it("answers a missing permission with forbidden", async () => {
    const { repository, requireSessionAccess } = createRepository({
      row: grantRow({ permissions: ["read_own"] }),
    });

    const result = await repository.resolveGrant(liveKey(), "send");

    expect(result).toEqual({ ok: false, code: "forbidden", status: 403 });
    expect(requireSessionAccess).toHaveBeenCalledOnce();
  });
});
