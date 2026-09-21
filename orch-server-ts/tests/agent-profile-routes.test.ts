import { createHash } from "node:crypto";

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  AgentProfileVersionConflictError,
  agentProfileRouteAuthRequirements,
  registerAgentProfileRoutes,
  resolveProductionRouteAuthRequirement,
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
    registerAgentProfileRoutes(app, { repository: repository() });

    const response = await app.inject({ method: "GET", url: "/api/agent-profiles/runtime" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ profiles: [expect.objectContaining({
      agent_id: "roselin",
      name: "로젤린",
      aliases: [{ id: "roselin_codex" }],
      has_portrait: false,
      version: 1,
    })] });
    expect(response.body).not.toContain("portrait_blob");
    await app.close();
  });

  it("validates optimistic create and maps conflicts to 409", async () => {
    const put = vi.fn(async () => { throw new AgentProfileVersionConflictError("roselin"); });
    const app = Fastify();
    registerAgentProfileRoutes(app, { repository: repository({ put }) });

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
      expectedVersion: null,
    }));
    await app.close();
  });

  it("rejects portrait MIME that disagrees with the bytes", async () => {
    const app = Fastify();
    registerAgentProfileRoutes(app, { repository: repository() });
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
    registerAgentProfileRoutes(app, { repository: repository({ putPortrait }) });
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
    registerAgentProfileRoutes(app, { repository: repository() });

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
    registerAgentProfileRoutes(app, { repository: repository() });

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
    registerAgentProfileRoutes(app, { repository: repository() });

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
    registerAgentProfileRoutes(app, { repository: repository({ put }) });

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
