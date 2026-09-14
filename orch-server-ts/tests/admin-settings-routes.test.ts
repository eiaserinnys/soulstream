import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  parseOrchServerConfig,
  SessionReviewPolicyError,
  type AdminUsersRouteProvider,
} from "../src/index.js";

const config = parseOrchServerConfig({
  environment: "test",
  databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
  authBearerToken: "service-token",
});

describe("admin session review policy routes", () => {
  it("returns readable policy metadata and writes with the authenticated admin email", async () => {
    const provider = makeProvider();
    const app = createApp({ config, adminUsersRoutes: { provider } });
    const get = await app.inject({
      method: "GET",
      url: "/api/admin/settings/session-review-policy",
    });
    expect(get.statusCode).toBe(200);
    const body = get.json();
    expect(body).toMatchObject({
      policy: { sourceAllowlist: ["slack"], version: 2 },
      conditionalRules: [{
        source: "browser",
        condition: "identified_user",
        description: "로그인한 브라우저 요청은 항상 검수합니다.",
      }],
      sourceCatalog: expect.arrayContaining([
        expect.objectContaining({
          source: "external-llm",
          label: "외부 LLM",
          description: "외부 LLM에서 직접 시작한 요청",
        }),
        expect.objectContaining({
          source: "llm",
          label: "공개 연동",
          description: "공개 연동을 통해 시작한 요청",
          automatic: true,
        }),
      ]),
    });
    const userFacingCopy = [
      ...body.conditionalRules.map((rule: { label: string; description: string }) =>
        `${rule.label} ${rule.description}`),
      ...body.sourceCatalog.map((entry: { label: string; description: string }) =>
        `${entry.label} ${entry.description}`),
    ].join(" ");
    expect(userFacingCopy).not.toMatch(/user_id|email|display_name|ingress|MCP|·/);

    const put = await app.inject({
      method: "PUT",
      url: "/api/admin/settings/session-review-policy",
      payload: { sourceAllowlist: ["external-llm", "clipper"], expectedVersion: 2 },
    });
    expect(put.statusCode).toBe(200);
    expect(provider.updateSessionReviewPolicy).toHaveBeenCalledWith({
      sourceAllowlist: ["external-llm", "clipper"],
      expectedVersion: 2,
      updatedBy: "admin@example.com",
    });
    await app.close();
  });

  it("denies both a regular dashboard user and an opaque service bearer", async () => {
    const regular = makeProvider({ isAdminEmail: vi.fn(async () => false) });
    const regularApp = createApp({ config, adminUsersRoutes: { provider: regular } });
    expect((await regularApp.inject({
      method: "PUT",
      url: "/api/admin/settings/session-review-policy",
      payload: { sourceAllowlist: [], expectedVersion: 2 },
    })).statusCode).toBe(403);
    expect(regular.updateSessionReviewPolicy).not.toHaveBeenCalled();
    await regularApp.close();

    const service = makeProvider({ currentEmail: vi.fn(async () => null) });
    const serviceApp = createApp({ config, adminUsersRoutes: { provider: service } });
    expect((await serviceApp.inject({
      method: "PUT",
      url: "/api/admin/settings/session-review-policy",
      headers: { authorization: "Bearer service-token" },
      payload: { sourceAllowlist: [], expectedVersion: 2 },
    })).statusCode).toBe(401);
    expect(service.updateSessionReviewPolicy).not.toHaveBeenCalled();
    await serviceApp.close();
  });

  it("returns 409 CAS and 503 storage failures with actionable error codes", async () => {
    for (const [error, statusCode] of [
      [new SessionReviewPolicyError(
        "SESSION_REVIEW_POLICY_CONFLICT",
        "Reload before saving.",
        409,
      ), 409],
      [new SessionReviewPolicyError(
        "SESSION_REVIEW_POLICY_UNAVAILABLE",
        "Apply database migration 091_system_settings.sql.",
        503,
      ), 503],
    ] as const) {
      const provider = makeProvider({
        updateSessionReviewPolicy: vi.fn(async () => { throw error; }),
      });
      const app = createApp({ config, adminUsersRoutes: { provider } });
      const response = await app.inject({
        method: "PUT",
        url: "/api/admin/settings/session-review-policy",
        payload: { sourceAllowlist: ["slack"], expectedVersion: 1 },
      });
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toMatchObject({
        detail: { error: { code: error.code, message: error.message } },
      });
      await app.close();
    }
  });
});

function makeProvider(
  overrides: Partial<AdminUsersRouteProvider> = {},
): AdminUsersRouteProvider & { updateSessionReviewPolicy: ReturnType<typeof vi.fn> } {
  const update = vi.fn(async (input: {
    sourceAllowlist: readonly unknown[];
    expectedVersion: number;
    updatedBy: string;
  }) => ({
    key: "session_review_policy" as const,
    sourceAllowlist: input.sourceAllowlist.map(String),
    version: input.expectedVersion + 1,
    updatedAt: "2026-09-14T00:00:01.000Z",
    updatedBy: input.updatedBy,
  }));
  return {
    currentEmail: vi.fn(async () => "admin@example.com"),
    isAdminEmail: vi.fn(async () => true),
    listUsers: vi.fn(async () => []),
    listFolders: vi.fn(async () => []),
    createUser: vi.fn(),
    updateUser: vi.fn(),
    deleteUser: vi.fn(),
    canRemoveAdmin: vi.fn(async () => true),
    broadcastAccessChange: vi.fn(),
    getSessionReviewPolicy: vi.fn(async () => ({
      key: "session_review_policy" as const,
      sourceAllowlist: ["slack"],
      version: 2,
      updatedAt: "2026-09-14T00:00:00.000Z",
      updatedBy: "migration:test",
    })),
    updateSessionReviewPolicy: update,
    ...overrides,
  } as AdminUsersRouteProvider & { updateSessionReviewPolicy: ReturnType<typeof vi.fn> };
}
