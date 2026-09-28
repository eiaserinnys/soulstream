import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  contextBundleRouteAuthRequirements,
  registerContextBundleRoutes,
  resolveProductionRouteAuthRequirement,
  type AgentProfileRecord,
  type AgentProfileRepository,
  type ContextBundleRecord,
  type ContextBundleRepository,
} from "../src/index.js";

const now = "2026-08-07T00:00:00.000Z";
const context = {
  node_id: "11111111-2222-3333-4444-555555555555",
  applies_when: { source: ["agent"], future_filter: ["keep-me"] },
};
const bundle: ContextBundleRecord = {
  bundleId: "people",
  description: "People context",
  atomContexts: [context],
  version: 1,
  createdAt: now,
  updatedAt: now,
};
const profile: AgentProfileRecord = {
  agentId: "roselin",
  name: "로젤린",
  atomContexts: [],
  contextBundles: ["people"],
  defaultPreset: null,
  aliases: [],
  hasPortrait: false,
  portrait: null,
  version: 1,
  createdAt: now,
  updatedAt: now,
};

function bundles(overrides: Partial<ContextBundleRepository> = {}): ContextBundleRepository {
  return {
    list: vi.fn(async () => [bundle]),
    get: vi.fn(async () => bundle),
    put: vi.fn(async () => bundle),
    delete: vi.fn(async () => true),
    ...overrides,
  };
}

function profiles(overrides: Partial<AgentProfileRepository> = {}): AgentProfileRepository {
  return {
    snapshot: () => [profile],
    list: vi.fn(async () => [profile]),
    get: vi.fn(async () => profile),
    put: vi.fn(async () => profile),
    delete: vi.fn(async () => true),
    getPortrait: vi.fn(async () => null),
    putPortrait: vi.fn(async () => profile),
    deletePortrait: vi.fn(async () => profile),
    ...overrides,
  };
}

describe("context bundle routes", () => {
  it("declares list and CRUD routes as protected", () => {
    expect(Object.values(contextBundleRouteAuthRequirements).every(Boolean)).toBe(true);
    expect(Object.keys(contextBundleRouteAuthRequirements)).toHaveLength(4);
    expect(resolveProductionRouteAuthRequirement({
      method: "DELETE",
      routeUrl: "/api/context-bundles/:bundle_id",
    })).toBe(true);
  });

  it("serves bundle list and detail projections", async () => {
    const app = Fastify();
    const repository = bundles();
    registerContextBundleRoutes(app, { repository, profileRepository: profiles() });

    const list = await app.inject({ method: "GET", url: "/api/context-bundles" });
    const detail = await app.inject({ method: "GET", url: "/api/context-bundles/people" });

    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ bundles: [{
      bundle_id: "people",
      description: "People context",
      atom_contexts: [context],
      version: 1,
      created_at: now,
      updated_at: now,
    }] });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual(list.json().bundles[0]);
    await app.close();
  });

  it("returns 404 for a missing bundle", async () => {
    const app = Fastify();
    registerContextBundleRoutes(app, {
      repository: bundles({ get: vi.fn(async () => null) }),
      profileRepository: profiles(),
    });

    const response = await app.inject({ method: "GET", url: "/api/context-bundles/missing" });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("writes bundle contexts without altering applies_when", async () => {
    const put = vi.fn(async () => bundle);
    const app = Fastify();
    registerContextBundleRoutes(app, {
      repository: bundles({ put }),
      profileRepository: profiles(),
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/context-bundles/people",
      payload: {
        description: "People context",
        atom_contexts: [context],
        expected_version: null,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(put).toHaveBeenCalledWith({
      bundleId: "people",
      description: "People context",
      atomContexts: [context],
      expectedVersion: null,
    });
    expect(response.json().atom_contexts[0].applies_when).toEqual(context.applies_when);
    await app.close();
  });

  it("rejects deleting a bundle referenced by profiles and reports each profile", async () => {
    const remove = vi.fn(async () => true);
    const profileRepository = profiles({
      list: vi.fn(async () => [profile, { ...profile, agentId: "ariella" }]),
    });
    const app = Fastify();
    registerContextBundleRoutes(app, {
      repository: bundles({ delete: remove }),
      profileRepository,
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/api/context-bundles/people",
      payload: { expected_version: 1 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().referenced_by).toEqual(["ariella", "roselin"]);
    expect(remove).not.toHaveBeenCalled();
    expect(profileRepository.list).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
