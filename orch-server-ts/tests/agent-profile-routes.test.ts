import { createHash } from "node:crypto";

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  AgentProfileVersionConflictError,
  agentProfileRouteAuthRequirements,
  registerAgentProfileRoutes,
  resolveProductionRouteAuthRequirement,
  type ContextBundleRecord,
  type ContextBundleRepository,
  type AgentProfileRecord,
  type AgentProfileRepository,
} from "../src/index.js";

const EXPECTED_PORTRAIT_MAX_BYTES = 5 * 1024 * 1024;
const ROSELIN_PORTRAIT_BYTES = 2_186_900;

function syntheticPng(size: number): Buffer {
  const body = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(body);
  return body;
}

function portraitPayload(body: Buffer) {
  return {
    data_base64: body.toString("base64"),
    mime: "image/png",
    sha256: createHash("sha256").update(body).digest("hex"),
    expected_version: 1,
  };
}

const profile: AgentProfileRecord = {
  agentId: "roselin",
  name: "로젤린",
  contextBundles: [],
  atomContexts: [{ node_id: "11111111-2222-3333-4444-555555555555", mode: "titles" }],
  defaultPreset: "codex-sol",
  aliases: [{ id: "roselin_codex" }],
  hasPortrait: false,
  portrait: null,
  version: 1,
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
};

function repository(overrides: Partial<AgentProfileRepository> = {}): AgentProfileRepository {
  return {
    snapshot: vi.fn(() => [profile]),
    list: vi.fn(async () => [profile]),
    get: vi.fn(async () => profile),
    put: vi.fn(async () => profile),
    delete: vi.fn(async () => true),
    getPortrait: vi.fn(async () => null),
    putPortrait: vi.fn(async () => ({ ...profile, hasPortrait: true, version: 2 })),
    deletePortrait: vi.fn(async () => profile),
    ...overrides,
  };
}

function bundles(overrides: Partial<ContextBundleRepository> = {}): ContextBundleRepository {
  return {
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
    put: vi.fn(async (input) => ({
      bundleId: input.bundleId,
      description: input.description,
      atomContexts: input.atomContexts,
      version: 1,
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    })),
    delete: vi.fn(async () => true),
    ...overrides,
  };
}

function registerRoutes(
  app: ReturnType<typeof Fastify>,
  profiles = repository(),
  contextBundles = bundles(),
): void {
  registerAgentProfileRoutes(app, { repository: profiles, bundleRepository: contextBundles });
}

describe("agent profile DB routes", () => {
  it("declares every CRUD and runtime route as protected", () => {
    expect(Object.values(agentProfileRouteAuthRequirements).every(Boolean)).toBe(true);
    expect(Object.keys(agentProfileRouteAuthRequirements)).toHaveLength(8);
    expect(resolveProductionRouteAuthRequirement({
      method: "PUT",
      routeUrl: "/api/agent-profiles/:agent_id",
    })).toBe(true);
  });

  it("serves runtime overlays without portrait bytes", async () => {
    const app = Fastify();
    registerRoutes(app);

    const response = await app.inject({ method: "GET", url: "/api/agent-profiles/runtime" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ profiles: [expect.objectContaining({
      agent_id: "roselin",
      name: "로젤린",
      atom_contexts: profile.atomContexts,
      aliases: [{ id: "roselin_codex" }],
      has_portrait: false,
      version: 1,
    })] });
    expect(response.body).not.toContain("portrait_blob");
    expect(response.json().profiles[0]).not.toHaveProperty("created_at");
    expect(response.json().profiles[0]).not.toHaveProperty("context_bundles");
    expect(response.json().profiles[0]).not.toHaveProperty("effective_atom_contexts");
    await app.close();
  });

  it("returns raw and effective contexts on profile reads", async () => {
    const app = Fastify();
    registerRoutes(app);

    const response = await app.inject({ method: "GET", url: "/api/agent-profiles" });
    const detail = await app.inject({ method: "GET", url: "/api/agent-profiles/roselin" });

    expect(response.statusCode).toBe(200);
    expect(response.json().profiles[0]).toMatchObject({
      context_bundles: [],
      atom_contexts: profile.atomContexts,
      effective_atom_contexts: profile.atomContexts,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      context_bundles: [],
      atom_contexts: profile.atomContexts,
      effective_atom_contexts: profile.atomContexts,
    });
    await app.close();
  });

  it("expands bundles in reference order before profile contexts and preserves applies_when", async () => {
    const ownContext = {
      node_id: "11111111-2222-3333-4444-555555555555",
      applies_when: { source: ["browser"] },
    };
    const profileWithBundles = { ...profile, contextBundles: ["first", "second"], atomContexts: [ownContext] };
    const profileRepo = repository({ list: vi.fn(async () => [profileWithBundles]) });
    const bundleRows: ContextBundleRecord[] = [
      {
        bundleId: "first",
        description: "first",
        atomContexts: [{ node_id: "21111111-2222-3333-4444-555555555555", applies_when: { source: ["agent"] } }],
        version: 1,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      },
      {
        bundleId: "second",
        description: "second",
        atomContexts: [{ node_id: "31111111-2222-3333-4444-555555555555" }],
        version: 1,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      },
    ];
    const bundleRepo = bundles({ list: vi.fn(async () => bundleRows) });
    const app = Fastify();
    registerRoutes(app, profileRepo, bundleRepo);

    const response = await app.inject({ method: "GET", url: "/api/agent-profiles/runtime" });

    expect(response.statusCode).toBe(200);
    expect(response.json().profiles[0].atom_contexts).toEqual([
      bundleRows[0]!.atomContexts[0],
      bundleRows[1]!.atomContexts[0],
      ownContext,
    ]);
    expect(bundleRepo.list).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("rejects unknown and duplicate bundle references before profile writes", async () => {
    const put = vi.fn(async () => profile);
    const app = Fastify();
    registerRoutes(app, repository({ put }), bundles());

    const unknown = await app.inject({
      method: "PUT",
      url: "/api/agent-profiles/roselin",
      payload: {
        name: "로젤린",
        atom_contexts: [],
        context_bundles: ["missing", "other"],
        default_preset: null,
        aliases: [],
        expected_version: null,
      },
    });
    const duplicate = await app.inject({
      method: "PUT",
      url: "/api/agent-profiles/roselin",
      payload: {
        name: "로젤린",
        atom_contexts: [],
        context_bundles: ["missing", "missing"],
        default_preset: null,
        aliases: [],
        expected_version: null,
      },
    });

    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().detail).toBe("unknown context bundles: missing, other");
    expect(duplicate.statusCode).toBe(422);
    expect(put).not.toHaveBeenCalled();
    await app.close();
  });

  it("validates optimistic create and maps conflicts to 409", async () => {
    const put = vi.fn(async () => { throw new AgentProfileVersionConflictError("roselin"); });
    const app = Fastify();
    registerRoutes(app, repository({ put }));

    const response = await app.inject({
      method: "PUT",
      url: "/api/agent-profiles/roselin",
      payload: {
        name: "로젤린",
        atom_contexts: [],
        default_preset: null,
        aliases: ["roselin_codex"],
        expected_version: null,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "agent_profile_version_conflict" });
    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "roselin",
      contextBundles: [],
      expectedVersion: null,
    }));
    await app.close();
  });

  it("rejects portrait MIME that disagrees with the bytes", async () => {
    const app = Fastify();
    registerRoutes(app);
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

    const response = await app.inject({
      method: "PUT",
      url: "/api/agent-profiles/roselin/portrait",
      payload: {
        data_base64: pngHeader.toString("base64"),
        mime: "image/jpeg",
        expected_version: 1,
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().detail).toContain("does not match");
    await app.close();
  });

  it("accepts the observed 2,916,002-byte portrait import payload", async () => {
    const putPortrait = vi.fn(async () => ({ ...profile, hasPortrait: true, version: 2 }));
    const app = Fastify();
    registerRoutes(app, repository({ putPortrait }));
    const payload = portraitPayload(syntheticPng(ROSELIN_PORTRAIT_BYTES));

    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBe(2_916_002);
    const response = await app.inject({
      method: "PUT",
      url: "/api/agent-profiles/roselin/portrait",
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(putPortrait).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ length: ROSELIN_PORTRAIT_BYTES }),
    }));
    await app.close();
  });

  it("accepts a 5MiB portrait and rejects one byte over with 422", async () => {
    const app = Fastify();
    registerRoutes(app);

    const atLimit = await app.inject({
      method: "PUT",
      url: "/api/agent-profiles/roselin/portrait",
      payload: portraitPayload(syntheticPng(EXPECTED_PORTRAIT_MAX_BYTES)),
    });
    const overLimit = await app.inject({
      method: "PUT",
      url: "/api/agent-profiles/roselin/portrait",
      payload: portraitPayload(syntheticPng(EXPECTED_PORTRAIT_MAX_BYTES + 1)),
    });

    expect(atLimit.statusCode).toBe(200);
    expect(overLimit.statusCode).toBe(422);
    expect(overLimit.json().detail).toContain("5MiB");
    await app.close();
  });

  it("keeps the default 1MiB body limit on non-portrait profile writes", async () => {
    const app = Fastify();
    registerRoutes(app);

    const response = await app.inject({
      method: "PUT",
      url: "/api/agent-profiles/roselin",
      payload: {
        name: "x".repeat(1024 * 1024),
        atom_contexts: [],
        default_preset: null,
        aliases: [],
        expected_version: 1,
      },
    });

    expect(response.statusCode).toBe(413);
    await app.close();
  });

  it("rejects atom context node ids that cannot execute as YAML profile contexts", async () => {
    const app = Fastify();
    registerRoutes(app);

    const response = await app.inject({
      method: "PUT",
      url: "/api/agent-profiles/roselin",
      payload: {
        name: "로젤린",
        atom_contexts: [{ node_id: "not-a-uuid" }],
        default_preset: null,
        aliases: [],
        expected_version: null,
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().detail).toContain("UUID");
    await app.close();
  });

  it("preserves applies_when objects in JSONB profile writes", async () => {
    const put = vi.fn(async () => profile);
    const app = Fastify();
    registerRoutes(app, repository({ put }));

    const response = await app.inject({
      method: "PUT",
      url: "/api/agent-profiles/roselin",
      payload: {
        name: "로젤린",
        atom_contexts: [{
          node_id: "11111111-2222-3333-4444-555555555555",
          mode: "titles",
          applies_when: {
            source: ["agent"],
            future_field: ["future-value"],
          },
        }],
        default_preset: null,
        aliases: [],
        expected_version: 1,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      atomContexts: [{
        node_id: "11111111-2222-3333-4444-555555555555",
        mode: "titles",
        applies_when: {
          source: ["agent"],
          future_field: ["future-value"],
        },
      }],
    }));
    await app.close();
  });
});
