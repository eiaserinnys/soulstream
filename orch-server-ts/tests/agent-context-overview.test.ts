import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerAgentContextOverviewRoutes } from "../src/node/agent_context_overview_routes.js";
import { NodeAgentProfileRouteError } from "../src/node/node_agent_profile_routes.js";

const ID = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ctx = (n: number) => ({ node_id: ID(n), depth: 1 });
const source = (n: number, extra: Record<string, unknown> = {}) => ({
  node_id: ID(n), mode: "full", depth: 1, applies_when: null, chars: 100 + n, token_estimate: 30 + n, status: "ok", ...extra,
});

const dbProfile = {
  agentId: "central", name: "Central", contextBundles: ["common"], atomContexts: [ctx(2)],
  defaultPreset: null, aliases: [], hasPortrait: false, portrait: null, version: 1, createdAt: "", updatedAt: "",
};

type PreviewCall = { agent_id?: string; ignore_conditions?: boolean; summary_only?: boolean; session?: Record<string, unknown> };

function setup(profiles: Record<string, Record<string, unknown>> | undefined, preview: (input: PreviewCall) => Promise<unknown>) {
  const calls: PreviewCall[] = [];
  const app = Fastify();
  registerAgentContextOverviewRoutes(app, {
    provider: {
      listAgentProfiles: async () => profiles as never,
      previewAgentContext: async (_node, input) => { calls.push(input as PreviewCall); return preview(input as PreviewCall); },
    },
    profileRepository: { list: async () => [dbProfile] },
    bundleRepository: { list: async () => [{ bundleId: "common", description: "", atomContexts: [ctx(1)], version: 1, createdAt: "", updatedAt: "" }] },
  });
  return { app, calls };
}

let open: ReturnType<typeof Fastify> | undefined;
afterEach(async () => { await open?.close(); open = undefined; });

describe("agent context overview", () => {
  it("previews each profile with conditions ignored and tags the three origins", async () => {
    const { app, calls } = setup(
      { central: { name: "Central", source: "db", backend: "claude" }, local: { name: "Local", source: "yaml" } },
      async (input) => ({ manifest: { sources: input.agent_id === "central"
        ? [source(1, { title: "rules", parent_title: "공통", documents: [{ node_id: ID(1) }] }), source(2)]
        : [source(3)] } }),
    );
    open = app;
    const body = (await app.inject({ url: "/api/nodes/node-a/agents/context-overview" })).json();

    expect(calls[0]).toMatchObject({ agent_id: "central", ignore_conditions: true, summary_only: true, session: { source: "browser", backend: "claude", agent: "central" } });
    expect(body.node_id).toBe("node-a");
    expect(typeof body.collected_at).toBe("string");
    expect(body.profiles.map((p: { agent_id: string }) => p.agent_id)).toEqual(["central", "local"]);
    const [central, local] = body.profiles;
    expect(central).toMatchObject({ display_name: "Central", source: "db", status: "ok", error: null });
    expect(central.sources.map((s: { origin: unknown }) => s.origin)).toEqual([
      { kind: "bundle", bundle_id: "common", bundle_name: "common" },
      { kind: "profile" },
    ]);
    expect(central.sources[0]).toMatchObject({ node_id: ID(1), title: "rules", parent_title: "공통", chars: 101, token_estimate: 31, documents: [{ node_id: ID(1) }] });
    expect(local.sources[0].origin).toEqual({ kind: "node_config" });
  });

  it("previews four profiles at a time", async () => {
    const profiles = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`p${i}`, { name: `P${i}`, source: "yaml" }]));
    let running = 0;
    let peak = 0;
    const { app } = setup(profiles, async () => {
      peak = Math.max(peak, ++running);
      await new Promise((resolve) => setTimeout(resolve, 15));
      running--;
      return { manifest: { sources: [] } };
    });
    open = app;
    const body = (await app.inject({ url: "/api/nodes/node-a/agents/context-overview" })).json();
    expect(body.profiles).toHaveLength(9);
    expect(peak).toBe(4);
  });

  it("marks only the failing profile as error and still answers 200", async () => {
    const { app } = setup(
      { good: { source: "yaml" }, bad: { source: "yaml" } },
      async (input) => { if (input.agent_id === "bad") throw new Error("boom"); return { manifest: { sources: [source(3)] } }; },
    );
    open = app;
    const response = await app.inject({ url: "/api/nodes/node-a/agents/context-overview" });
    expect(response.statusCode).toBe(200);
    const [good, bad] = response.json().profiles;
    expect(good.status).toBe("ok");
    expect(bad).toMatchObject({ status: "error", error: "boom", sources: [] });
  });

  it("fills null and [] when the preview has no title, parent_title, or documents yet", async () => {
    const { app } = setup({ old: { source: "yaml" } }, async () => ({ manifest: { sources: [source(3)] } }));
    open = app;
    const body = (await app.inject({ url: "/api/nodes/node-a/agents/context-overview" })).json();
    expect(body.profiles[0].sources[0]).toMatchObject({ title: null, parent_title: null, documents: [] });
  });

  it("answers the same error as the preview route when the node is not connected", async () => {
    const { app } = setup(undefined, async () => { throw new NodeAgentProfileRouteError("X", "x", 500); });
    open = app;
    const response = await app.inject({ url: "/api/nodes/node-z/agents/context-overview" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("NODE_AGENT_CONTEXT_PREVIEW_UNAVAILABLE");
  });
});
