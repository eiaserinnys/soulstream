import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { AtomContextSpec, AtomFetchConfig } from "../../src/context/atom_context.js";
import { buildContextFilterParameters } from "../../src/context/context_builder_helpers.js";
import { compileContexts } from "../../src/context/compiler/index.js";
import { registerContextPreviewRoute } from "../../src/context/context_preview_route.js";
import type { Task } from "../../src/task/task_models.js";

const BACKGROUND_ATOM_NODE_ID = "73fa7cb9-238f-4129-8455-2a8963e14bd6";
const BACKGROUND_MARKER = "Bash 도구의 `run_in_background=true` 금지.";
const atomConfig: AtomFetchConfig = {
  enabled: true,
  serverUrl: "https://atom.test",
  apiKey: "key",
};
const logger = { warn: vi.fn() };

function backgroundSource(): AtomContextSpec {
  return {
    nodeId: BACKGROUND_ATOM_NODE_ID,
    depth: 5,
    titlesOnly: false,
    appliesWhen: { backend: ["claude"] },
  };
}

function markerCount(markdown: string | null): number {
  return markdown?.split(BACKGROUND_MARKER).length - 1 || 0;
}

describe("effective-backend prompt containment full slice", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    logger.warn.mockClear();
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ markdown: `# background-tasks.md\n${BACKGROUND_MARKER}` }), {
        status: 200,
      })) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("filters seosoyoung_codex through the preview contract using its effective Codex backend", async () => {
    const app = Fastify();
    registerContextPreviewRoute(app, {
      nodeId: "eiaserinnys",
      atom: atomConfig,
      auth: {
        authBearerToken: "",
        environment: "development",
        dashboardAuthEnabled: false,
      },
      logger,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/context/preview",
        payload: {
          atom_contexts: [{
            node_id: BACKGROUND_ATOM_NODE_ID,
            depth: 5,
            applies_when: { backend: ["claude"] },
          }],
          session: {
            source: "agent",
            agent: "seosoyoung",
            backend: "codex",
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        manifest: {
          sources: [expect.objectContaining({ status: "filtered", chars: 0 })],
        },
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("filters ariella-system2-sol when the compiler receives its effective Codex backend", async () => {
    const compiled = await compileContexts(
      atomConfig,
      [backgroundSource()],
      logger,
      {
        source: "agent",
        node_id: "eiaserinnys",
        agent: "ariella-system2",
        backend: "codex",
      },
    );

    expect(markerCount(compiled.assembled)).toBe(0);
    expect(compiled.manifest.sources[0]?.status).toBe("filtered");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("includes roselin_kimi from the preset-resolved Claude backend rather than profile.backend", async () => {
    const agent = {
      id: "roselin",
      name: "로젤린",
      backend: "codex",
      workspace_dir: "/workspace",
    } satisfies AgentProfile;
    const task = {
      modelPresetBackend: "claude",
      callerInfo: { source: "agent" },
    } as Task;
    const parameters = buildContextFilterParameters({
      task,
      agent,
      nodeId: "eiaserinnys",
      primaryContainer: null,
    });

    expect(parameters.backend).toBe("claude");
    const compiled = await compileContexts(
      atomConfig,
      [backgroundSource()],
      logger,
      parameters,
    );
    expect(markerCount(compiled.assembled)).toBe(1);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["seosoyoung", "claude", 1],
    ["seosoyoung-opus", "claude", 1],
    ["roselin", "codex", 0],
    ["roselin_codex", "codex", 0],
    ["remiel", "claude", 1],
    ["writer-seosoyoung", "claude", 1],
    ["writer-seosoyoung-opus", "claude", 1],
    ["zombie-labyrinth-bot", "codex", 0],
    ["ariella-system2", "claude", 1],
    ["keke", "claude", 1],
    ["keke-opus", "claude", 1],
  ] as const)(
    "keeps the satisfied production selector %s at %s/count=%i",
    async (_selector, backend, expectedCount) => {
      const compiled = await compileContexts(
        atomConfig,
        expectedCount === 1
          ? [{ nodeId: BACKGROUND_ATOM_NODE_ID, depth: 5, titlesOnly: false }]
          : [],
        logger,
        { backend },
      );

      expect(markerCount(compiled.assembled)).toBe(expectedCount);
    },
  );
});
