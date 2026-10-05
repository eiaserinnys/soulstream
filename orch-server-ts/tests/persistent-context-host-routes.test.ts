import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerPersistentContextHostRoutes } from "../src/persistent-context/persistent_context_host_routes.js";
import type { PersistentContextService } from "../src/persistent-context/persistent_context_service.js";
import type { PersistentContextEvaluationInput } from "../src/persistent-context/persistent_context_types.js";

describe("persistent context host route", () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

  it("requires service bearer auth and rejects invalid budgets before evaluation", async () => {
    const app = Fastify(); apps.push(app);
    const evaluatePersistentCandidates = vi.fn(async (_input: PersistentContextEvaluationInput) => ({ observation: null }));
    registerPersistentContextHostRoutes(app, {
      authBearerToken: "service-secret",
      service: { evaluatePersistentCandidates } as unknown as PersistentContextService,
      logNullReason: vi.fn(),
    });

    const unauthorized = await app.inject({
      method: "POST", url: "/api/persistent-context/host/evaluate",
      payload: { args: { session_id: "session", input_id: "input", request: "요청", budget_ms: 500 } },
    });
    const invalidBudget = await app.inject({
      method: "POST", url: "/api/persistent-context/host/evaluate",
      headers: { authorization: "Bearer service-secret" },
      payload: { args: { session_id: "session", input_id: "input", request: "요청", budget_ms: 3001 } },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(invalidBudget.statusCode).toBe(400);
    expect(evaluatePersistentCandidates).not.toHaveBeenCalled();
  });

  it("forwards the budget deadline and emits only an observation envelope", async () => {
    const app = Fastify(); apps.push(app);
    const evaluatePersistentCandidates = vi.fn(async (_input: PersistentContextEvaluationInput) => ({ observation: null }));
    registerPersistentContextHostRoutes(app, {
      authBearerToken: "service-secret",
      service: { evaluatePersistentCandidates } as unknown as PersistentContextService,
      logNullReason: vi.fn(),
    });
    const before = Date.now();
    const response = await app.inject({
      method: "POST", url: "/api/persistent-context/host/evaluate",
      headers: { authorization: "Bearer service-secret" },
      payload: { args: { session_id: "session", input_id: "input", request: "요청", budget_ms: 1000 } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ observation: null });
    expect(evaluatePersistentCandidates).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session", inputId: "input", request: "요청", signal: expect.any(AbortSignal),
      deadlineAt: expect.any(Number),
    }));
    const input = evaluatePersistentCandidates.mock.calls[0]?.[0];
    expect(input?.deadlineAt).toBeGreaterThanOrEqual(before + 900);
    expect(input?.deadlineAt).toBeLessThanOrEqual(before + 1100);
  });

  it("logs the route deadline and unexpected error null paths once", async () => {
    const app = Fastify(); apps.push(app);
    const logNullReason = vi.fn();
    const evaluatePersistentCandidates = vi.fn(async (_input: PersistentContextEvaluationInput) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { observation: { input_id: "input", selected: [] } };
    });
    registerPersistentContextHostRoutes(app, {
      authBearerToken: "service-secret",
      service: { evaluatePersistentCandidates } as unknown as PersistentContextService,
      logNullReason,
    });
    const deadlineResponse = await app.inject({
      method: "POST", url: "/api/persistent-context/host/evaluate",
      headers: { authorization: "Bearer service-secret" },
      payload: { args: { session_id: "deadline-session", input_id: "input", request: "request", budget_ms: 1 } },
    });
    expect(deadlineResponse.json()).toEqual({ observation: null });
    expect(logNullReason).toHaveBeenCalledTimes(1);
    expect(logNullReason).toHaveBeenLastCalledWith("cancelled_or_deadline", "deadline-session", expect.any(Number));

    evaluatePersistentCandidates.mockRejectedValueOnce(new Error("private request details"));
    const errorResponse = await app.inject({
      method: "POST", url: "/api/persistent-context/host/evaluate",
      headers: { authorization: "Bearer service-secret" },
      payload: { args: { session_id: "error-session", input_id: "input", request: "request", budget_ms: 1_000 } },
    });
    expect(errorResponse.json()).toEqual({ observation: null });
    expect(logNullReason).toHaveBeenCalledTimes(2);
    expect(logNullReason).toHaveBeenLastCalledWith("unexpected_error", "error-session", expect.any(Number));
  });

  it("does not log again when the service already returned null", async () => {
    const app = Fastify(); apps.push(app);
    const logNullReason = vi.fn();
    const evaluatePersistentCandidates = vi.fn(async () => ({ observation: null }));
    registerPersistentContextHostRoutes(app, {
      authBearerToken: "service-secret",
      service: { evaluatePersistentCandidates } as unknown as PersistentContextService,
      logNullReason,
    });
    const response = await app.inject({
      method: "POST", url: "/api/persistent-context/host/evaluate",
      headers: { authorization: "Bearer service-secret" },
      payload: { args: { session_id: "service-null", input_id: "input", request: "request", budget_ms: 1_000 } },
    });
    expect(response.json()).toEqual({ observation: null });
    expect(logNullReason).not.toHaveBeenCalled();
  });
});
