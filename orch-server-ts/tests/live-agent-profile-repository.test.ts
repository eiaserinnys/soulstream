import { describe, expect, it } from "vitest";

import { createFakeAgentPortraits } from "./fake_agent_portraits.js";
import {
  AgentProfileVersionConflictError,
  createLiveAgentProfileRepository,
  type LiveDbSqlResolver,
  type LivePostgresSql,
} from "../src/index.js";

const portraitBody = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function centralPortraits() {
  return createFakeAgentPortraits([
    { agentId: "roselin", body: portraitBody, mime: "image/png", sha256: "a".repeat(64) },
  ]);
}

function harness(responses: Array<readonly Record<string, unknown>[]>, portraits = centralPortraits()) {
  const queries: string[] = [];
  const sql = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
    queries.push(strings.join("?"));
    return Promise.resolve(responses.shift() ?? []);
  }) as LivePostgresSql;
  Object.assign(sql, { json: (value: unknown) => value });
  const resolver: LiveDbSqlResolver = {
    resolveSql: async () => sql,
    close: async () => undefined,
  };
  return { repository: createLiveAgentProfileRepository(resolver, portraits), queries, portraits };
}

const row = {
  agent_id: "roselin",
  name: "로젤린",
  context_bundles: ["people", "general"],
  atom_contexts: [{ node_id: "11111111-2222-3333-4444-555555555555" }],
  default_preset: "codex-sol",
  aliases: [{ id: "roselin_codex" }],
  version: 2,
  created_at: new Date("2026-08-07T00:00:00.000Z"),
  updated_at: new Date("2026-08-07T01:00:00.000Z"),
};

describe("live agent profile repository", () => {
  it("maps profile and portrait metadata without returning bytes", async () => {
    const { repository } = harness([[row]]);

    await expect(repository.list()).resolves.toEqual([{
      agentId: "roselin",
      name: "로젤린",
      contextBundles: ["people", "general"],
      atomContexts: row.atom_contexts,
      defaultPreset: "codex-sol",
      aliases: [{ id: "roselin_codex" }],
      hasPortrait: true,
      portrait: { mime: "image/png", size: 4, sha256: "a".repeat(64) },
      version: 2,
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T01:00:00.000Z",
    }]);
    expect(repository.snapshot()).toEqual([
      expect.objectContaining({ agentId: "roselin", version: 2 }),
    ]);
  });

  it("keeps the synchronous routing snapshot current across writes and deletes", async () => {
    const created = { ...row, version: 1 };
    const updated = { ...row, name: "로젤린 DB", version: 2 };
    const { repository } = harness([[created], [updated], [{ agent_id: "roselin" }]]);

    await repository.put({
      agentId: "roselin",
      name: "로젤린",
      contextBundles: [],
      atomContexts: [],
      defaultPreset: null,
      aliases: [],
      expectedVersion: null,
    });
    expect(repository.snapshot()).toEqual([
      expect.objectContaining({ agentId: "roselin", version: 1 }),
    ]);

    await repository.put({
      agentId: "roselin",
      name: "로젤린 DB",
      contextBundles: ["people"],
      atomContexts: [],
      defaultPreset: "codex-sol",
      aliases: [],
      expectedVersion: 1,
    });
    expect(repository.snapshot()).toEqual([
      expect.objectContaining({ name: "로젤린 DB", version: 2 }),
    ]);

    await expect(repository.delete("roselin", 2)).resolves.toBe(true);
    expect(repository.snapshot()).toEqual([]);
  });

  it("requires null expectedVersion for create and exact version for update", async () => {
    const create = harness([[{ ...row, version: 1 }]]);
    await expect(create.repository.put({
      agentId: "roselin",
      name: "로젤린",
      contextBundles: [],
      atomContexts: [],
      defaultPreset: null,
      aliases: [],
      expectedVersion: null,
    })).resolves.toMatchObject({ version: 1 });
    expect(create.queries[0]).toContain("INSERT INTO agent_profiles");

    const conflict = harness([[]]);
    await expect(conflict.repository.put({
      agentId: "roselin",
      name: "로젤린",
      contextBundles: [],
      atomContexts: [],
      defaultPreset: null,
      aliases: [],
      expectedVersion: 4,
    })).rejects.toBeInstanceOf(AgentProfileVersionConflictError);
    expect(conflict.queries[0]).toContain("AND version =");
  });

  it("takes portrait presence from the central store and ignores the retired profile columns", async () => {
    const withLegacyColumns = { ...row, portrait_blob: portraitBody, portrait_mime: "image/gif", portrait_sha256: "c".repeat(64) };
    const { repository, portraits } = harness([[withLegacyColumns], [{ ...row, agent_id: "keke", name: "keke" }]]);

    await expect(repository.list()).resolves.toEqual([
      expect.objectContaining({
        hasPortrait: true,
        portrait: { mime: "image/png", size: 4, sha256: "a".repeat(64) },
      }),
    ]);
    await portraits.remove("roselin");
    expect(repository.snapshot()).toEqual([
      expect.objectContaining({ agentId: "roselin", hasPortrait: false, portrait: null }),
    ]);
    await expect(repository.get("keke")).resolves.toMatchObject({ hasPortrait: false, portrait: null });
  });

  it("treats the pre-migration undefined table as an empty dual-read source", async () => {
    const undefinedTable = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const sql = (() => { throw undefinedTable; }) as unknown as LivePostgresSql;
    Object.assign(sql, { json: (value: unknown) => value });
    const repository = createLiveAgentProfileRepository({
      resolveSql: async () => sql,
      close: async () => undefined,
    }, createFakeAgentPortraits());

    await expect(repository.list()).resolves.toEqual([]);
    await expect(repository.get("roselin")).resolves.toBeNull();
  });
});
