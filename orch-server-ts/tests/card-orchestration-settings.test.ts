import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  parseOrchestrationPolicy,
  parseOrchestrationDecision,
} from "../../packages/wire-schema/src/card_orchestration.js";
import { registerCardOrchestrationRoutes } from "../src/cards/card_orchestration_routes.js";
import { updateCardOrchestrationSettings } from "../src/cards/card_orchestration_settings.js";
const policy = {
  enabled: true,
  candidates: [
    {
      agentId: "ariella-orchestrator",
      nodeId: "eiaserinnys",
      modelPreset: "claude-opus",
      minimumRemainingPercent: 15,
    },
  ],
  usageMaxAgeMs: 300000 as const,
  sessionFolderId: null,
  systemFolderParentId: null,
};
const settings = {
  key: "card_orchestration" as const,
  policy,
  version: 1,
  updatedAt: "2026-10-01T00:00:00Z",
  updatedBy: "admin@example.com",
};
function setup(overrides = {}) {
  const get = vi.fn(async () => settings),
    put = vi.fn(async (input: any) => ({
      ...settings,
      policy: input.policy,
      version: 2,
      updatedBy: input.updatedBy,
    }));
  const options = {
    get,
    put,
    currentEmail: () => "admin@example.com",
    isAdminEmail: (email: string) => email === "admin@example.com",
    authBearerToken: "service-token",
    environment: "test",
    resolveCaller: async () => ({
      ownerEmail: "admin@example.com",
      purpose: null,
    }),
    validateFolder: async () => true,
    ...overrides,
  };
  const app = Fastify();
  registerCardOrchestrationRoutes(app, options);
  return { app, get, put };
}
describe("card orchestration policy boundary", () => {
  it("preserves ordered candidates and rejects weak or unrecognized input", () => {
    expect(parseOrchestrationPolicy(policy)).toEqual(policy);
    for (const bad of [
      { ...policy, usageMaxAgeMs: 300001 },
      {
        ...policy,
        candidates: [{ ...policy.candidates[0], minimumRemainingPercent: 101 }],
      },
      { ...policy, sessionFolderId: "bad" },
      { ...policy, credential: "hidden" },
    ])
      expect(() => parseOrchestrationPolicy(bad)).toThrow();
    expect(() =>
      parseOrchestrationDecision({
        decisions: [
          {
            cardId: "x",
            cardVersion: 1,
            action: "run",
            reason: "yes",
            launch: true,
          },
        ],
      }),
    ).toThrow();
  });
  it("uses authenticated admin attribution for browser and persisted owner for MCP", async () => {
    const { app, put } = setup();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings/card-orchestration",
          payload: { policy, expectedVersion: 1, updatedBy: "attacker" },
        })
      ).statusCode,
    ).toBe(200);
    expect(put).toHaveBeenLastCalledWith({
      policy,
      expectedVersion: 1,
      updatedBy: "admin@example.com",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/card-orchestration/host/update",
          headers: { authorization: "Bearer service-token" },
          payload: {
            callerSessionId: "session",
            policy,
            expectedVersion: 1,
            email: "attacker",
            isAdmin: true,
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(put).toHaveBeenLastCalledWith({
      policy,
      expectedVersion: 1,
      updatedBy: "admin@example.com",
    });
    await app.close();
  });
  it("denies service-only browser calls, unverified owners and purpose decision sessions", async () => {
    for (const overrides of [
      { currentEmail: () => null },
      { isAdminEmail: () => false },
    ]) {
      const { app, put } = setup(overrides);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/settings/card-orchestration",
            payload: { policy, expectedVersion: 1 },
          })
        ).statusCode,
      ).toBeGreaterThanOrEqual(401);
      expect(put).not.toHaveBeenCalled();
      await app.close();
    }
    for (const caller of [
      null,
      { ownerEmail: "other@example.com", purpose: null },
      {
        ownerEmail: "admin@example.com",
        purpose: "card_orchestration_decision",
      },
    ]) {
      const { app, put } = setup({ resolveCaller: async () => caller });
      const r = await app.inject({
        method: "POST",
        url: "/api/card-orchestration/host/update",
        headers: { authorization: "Bearer service-token" },
        payload: {
          callerSessionId: "session",
          policy,
          expectedVersion: 1,
          isAdmin: true,
        },
      });
      expect(r.statusCode).toBe(403);
      expect(put).not.toHaveBeenCalled();
      await app.close();
    }
  });
  it("rejects explicit inaccessible folder and preserves CAS conflict", async () => {
    const { app, put } = setup({ validateFolder: async () => false });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/settings/card-orchestration",
          payload: {
            policy: {
              ...policy,
              sessionFolderId: "3ccbeda9-383d-496d-af35-9685a9130f64",
            },
            expectedVersion: 1,
          },
        })
      ).statusCode,
    ).toBe(422);
    expect(put).not.toHaveBeenCalled();
    await app.close();
    const sql: any = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) =>
        strings.join("").startsWith("UPDATE")
          ? []
          : [
              {
                value: policy,
                version: 2,
                updated_at: new Date(),
                updated_by: "admin",
              },
            ],
      ),
      { json: (x: any) => x },
    );
    await expect(
      updateCardOrchestrationSettings(sql, {
        policy,
        expectedVersion: 1,
        updatedBy: "admin",
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
it("never resolves callers without shared service authentication and returns optional status", async () => {
  const resolveCaller = vi.fn(async () => ({
    ownerEmail: "admin@example.com",
    purpose: null,
  }));
  const { app } = setup({
    resolveCaller,
    readStatus: async () => ({ state: "blocked", reason: "usage_stale" }),
  });
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/card-orchestration/host/get",
        payload: { callerSessionId: "session", isAdmin: true },
      })
    ).statusCode,
  ).toBe(401);
  expect(resolveCaller).not.toHaveBeenCalled();
  expect(
    (
      await app.inject({
        method: "GET",
        url: "/api/settings/card-orchestration",
      })
    ).json(),
  ).toMatchObject({ settings, status: { reason: "usage_stale" } });
  await app.close();
});
