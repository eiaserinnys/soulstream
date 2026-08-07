import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentProfileSource } from "../src/agent_profile_source.js";

const directories: string[] = [];
const logger = pino({ level: "silent" });

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "agent-profile-source-"));
  directories.push(directory);
  const agentsConfigPath = join(directory, "agents.yaml");
  const cachePath = join(directory, "cache", "profiles.json");
  await writeFile(agentsConfigPath, `agents:\n  - id: roselin\n    name: YAML Roselin\n    backend: codex\n    workspace_dir: /tmp/roselin\n    default_preset: yaml-preset\n    aliases:\n      - yaml-alias\n    atom_contexts:\n      - node_id: 11111111-2222-3333-4444-555555555555\n        depth: 1\n`, "utf8");
  return { agentsConfigPath, cachePath };
}

function remote(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: "roselin",
    name: "DB Roselin",
    atom_contexts: [{ node_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", depth: 2, mode: "titles" }],
    default_preset: "db-preset",
    aliases: [{ id: "db-alias" }],
    has_portrait: true,
    portrait: { mime: "image/png", size: 4, sha256: "a".repeat(64) },
    version: 3,
    updated_at: "2026-08-07T00:00:00.000Z",
    ...overrides,
  };
}

describe("AgentProfileSource", () => {
  it("preserves YAML behavior exactly when the DB runtime list is empty", async () => {
    const files = await fixture();
    const source = new AgentProfileSource({
      ...files,
      runtimeUrl: "http://orch/api/agent-profiles/runtime",
      logger,
      fetchRuntime: async () => ({ profiles: [] }),
    });

    const resolved = await source.resolve("yaml-alias");

    expect(resolved?.profile).toMatchObject({
      id: "roselin",
      name: "YAML Roselin",
      workspace_dir: "/tmp/roselin",
      default_preset: "yaml-preset",
    });
    expect(resolved?.source).toBe("yaml");
    expect(source.state()).toMatchObject({ stale: false, counts: { db: 0, yaml: 1 } });
  });

  it("overlays only DB-owned fields and retains YAML execution fields", async () => {
    const files = await fixture();
    const source = new AgentProfileSource({
      ...files,
      runtimeUrl: "http://orch/api/agent-profiles/runtime",
      logger,
      fetchRuntime: async () => ({ profiles: [remote()] }),
    });

    const resolved = await source.resolve("db-alias");

    expect(resolved).toMatchObject({ source: "db", stale: false, hasPortrait: true });
    expect(resolved?.profile).toMatchObject({
      id: "roselin",
      name: "DB Roselin",
      backend: "codex",
      workspace_dir: "/tmp/roselin",
      default_preset: "db-preset",
      aliases: [{ id: "db-alias" }],
    });
  });

  it("preserves DB atom_contexts applies_when for compiler evaluation", async () => {
    const files = await fixture();
    const source = new AgentProfileSource({
      ...files,
      runtimeUrl: "http://orch/api/agent-profiles/runtime",
      logger,
      fetchRuntime: async () => ({ profiles: [remote({
        atom_contexts: [{
          node_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          depth: 2,
          mode: "titles",
          applies_when: { source: ["agent"], future_field: ["future-value"] },
        }],
      })] }),
    });

    const resolved = await source.resolve("roselin");

    expect(resolved?.profile.atom_contexts?.[0]?.applies_when).toEqual({
      source: ["agent"],
      future_field: ["future-value"],
    });
  });

  it("uses an atomic last-known-good overlay and marks it stale on outage", async () => {
    const files = await fixture();
    const online = new AgentProfileSource({
      ...files,
      runtimeUrl: "http://orch/api/agent-profiles/runtime",
      logger,
      fetchRuntime: async () => ({ profiles: [remote()] }),
    });
    await online.resolve("roselin");
    expect(JSON.parse(await readFile(files.cachePath, "utf8"))).toMatchObject({ schema_version: 1 });

    const offline = new AgentProfileSource({
      ...files,
      runtimeUrl: "http://orch/api/agent-profiles/runtime",
      logger,
      fetchRuntime: async () => { throw new Error("orch down"); },
    });
    const resolved = await offline.resolve("roselin");

    expect(resolved?.profile.name).toBe("DB Roselin");
    expect(offline.state()).toMatchObject({ stale: true, lastError: "orch down" });
  });

  it("falls back to YAML and stale=true when the cache is corrupt", async () => {
    const files = await fixture();
    await mkdir(dirname(files.cachePath), { recursive: true });
    await writeFile(files.cachePath, "not-json", "utf8");
    const source = new AgentProfileSource({
      ...files,
      runtimeUrl: "http://orch/api/agent-profiles/runtime",
      logger,
      fetchRuntime: async () => { throw new Error("orch down"); },
    });

    expect((await source.resolve("roselin"))?.profile.name).toBe("YAML Roselin");
    expect(source.state().stale).toBe(true);
  });

  it("bounds the orchestrator read so an outage cannot block last-known-good startup", async () => {
    const files = await fixture();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ profiles: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const source = new AgentProfileSource({
      ...files,
      runtimeUrl: "http://orch/api/agent-profiles/runtime",
      fetchTimeoutMs: 25,
      logger,
    });

    await source.initialize();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://orch/api/agent-profiles/runtime",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("keeps a fresh DB overlay when only cache persistence fails", async () => {
    const files = await fixture();
    const blockedParent = join(dirname(files.cachePath), "blocked");
    await mkdir(dirname(files.cachePath), { recursive: true });
    await writeFile(blockedParent, "not a directory", "utf8");
    const source = new AgentProfileSource({
      ...files,
      cachePath: join(blockedParent, "profiles.json"),
      runtimeUrl: "http://orch/api/agent-profiles/runtime",
      logger,
      fetchRuntime: async () => ({ profiles: [remote()] }),
    });

    const resolved = await source.resolve("roselin");

    expect(resolved).toMatchObject({ source: "db", stale: false });
    expect(resolved?.profile.name).toBe("DB Roselin");
  });

  it("promotes only executable merged profiles into the last-known-good cache", async () => {
    const files = await fixture();
    const online = new AgentProfileSource({
      ...files,
      runtimeUrl: "http://orch/api/agent-profiles/runtime",
      logger,
      fetchRuntime: async () => ({ profiles: [remote()] }),
    });
    await online.resolve("roselin");

    const invalid = new AgentProfileSource({
      ...files,
      runtimeUrl: "http://orch/api/agent-profiles/runtime",
      logger,
      fetchRuntime: async () => ({
        profiles: [remote({
          name: "Poisoned DB Roselin",
          atom_contexts: [{ node_id: "not-a-uuid" }],
        })],
      }),
    });

    const resolved = await invalid.resolve("roselin");

    expect(resolved).toMatchObject({ source: "db", stale: true });
    expect(resolved?.profile.name).toBe("DB Roselin");
    expect(JSON.parse(await readFile(files.cachePath, "utf8")))
      .toMatchObject({ profiles: [{ name: "DB Roselin" }] });
  });
});
