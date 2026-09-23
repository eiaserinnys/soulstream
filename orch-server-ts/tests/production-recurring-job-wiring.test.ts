import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  createLiveAuthJwtHelper,
  createLiveAuthenticatedUserResolvers,
  createProductionRecurringJobWiring,
  RecurringJobService,
  type LiveConfigProviderBoundary,
  type RecurringJob,
  type RecurringJobRepository,
} from "../src/index.js";

describe("production recurring job wiring", () => {
  it("shares one service with HTTP routes, host routes, and the scheduler", async () => {
    const dueJob = {} as RecurringJob;
    const repository = {
      listDueJobs: vi.fn(async () => [dueJob]),
      listActiveRuns: vi.fn(async () => []),
    } as unknown as RecurringJobRepository;
    const service = new RecurringJobService({ repository });
    const reserveAndDispatchDueJob = vi.spyOn(service, "reserveAndDispatchDueJob")
      .mockResolvedValue(null);
    const wiring = createProductionRecurringJobWiring({
      service,
      repository,
      authenticatedUserResolvers: createAuthenticatedUserResolvers(),
      authBearerToken: "service-token",
      onError: vi.fn(),
    });

    expect(wiring.routes.service).toBe(service);
    expect(wiring.hostRoutes.service).toBe(service);
    await wiring.scheduler.tick();
    expect(reserveAndDispatchDueJob).toHaveBeenCalledWith(dueJob);
  });

  it("derives actor identity and source from authenticated JWT credentials only", async () => {
    const wiring = createWiring();
    const browserJwt = await jwt().issueToken({
      email: "browser@example.com",
      name: "Browser User",
    });
    const nativeJwt = await jwt().issueToken({
      email: "native@example.com",
      name: "Native User",
    });

    await expect(wiring.routes.resolveActor(request({
      body: {
        ownerEmail: "spoofed@example.com",
        actorId: "spoofed",
        source: "agent",
        callerInfo: { source: "agent", user_id: "spoofed" },
      },
    }))).resolves.toBeNull();

    await expect(wiring.routes.resolveActor(request({
      cookie: `soul_dashboard_auth=${browserJwt}`,
      body: { ownerEmail: "spoofed@example.com", source: "soul-app" },
    }))).resolves.toMatchObject({
      ownerEmail: "browser@example.com",
      actorId: "browser@example.com",
      source: "browser",
      callerInfo: {
        source: "browser",
        email: "browser@example.com",
        user_id: "browser@example.com",
      },
    });

    await expect(wiring.routes.resolveActor(request({
      authorization: `Bearer ${nativeJwt}`,
      body: { ownerEmail: "spoofed@example.com", source: "browser" },
    }))).resolves.toMatchObject({
      ownerEmail: "native@example.com",
      actorId: "native@example.com",
      source: "soul-app",
      callerInfo: {
        source: "soul-app",
        email: "native@example.com",
        user_id: "native@example.com",
      },
    });
  });
});

function createWiring() {
  const repository = {} as RecurringJobRepository;
  return createProductionRecurringJobWiring({
    service: new RecurringJobService({ repository }),
    repository,
    authenticatedUserResolvers: createAuthenticatedUserResolvers(),
    authBearerToken: "service-token",
    onError: vi.fn(),
  });
}

function createAuthenticatedUserResolvers() {
  return createLiveAuthenticatedUserResolvers({
    jwt: jwt(),
  });
}

function jwt() {
  return createLiveAuthJwtHelper({
    configProvider: jwtConfigProvider(),
  });
}

function jwtConfigProvider(): LiveConfigProviderBoundary {
  return {
    getConfig: vi.fn(async () => ({ jwt_secret: "recurring-jobs-test-secret" })),
    requireConfig: vi.fn(async (key: string) => {
      if (key !== "jwt_secret") throw new Error(`unexpected config key ${key}`);
      return "recurring-jobs-test-secret";
    }),
  };
}

function request(options: {
  readonly cookie?: string;
  readonly authorization?: string;
  readonly body?: unknown;
}): FastifyRequest {
  return {
    headers: {
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...(options.authorization === undefined
        ? {}
        : { authorization: options.authorization }),
    },
    body: options.body,
  } as unknown as FastifyRequest;
}
