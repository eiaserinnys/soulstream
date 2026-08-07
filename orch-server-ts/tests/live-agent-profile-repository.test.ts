import { describe, expect, it } from "vitest";

import {
  AgentProfileVersionConflictError,
  createLiveAgentProfileRepository,
  type LiveDbSqlResolver,
  type LivePostgresSql,
} from "../src/index.js";

function harness(responses: Array<readonly Record<string, unknown>[]>) {
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
  return { repository: createLiveAgentProfileRepository(resolver), queries };
}

const row = {
  agent_id: "roselin",
  name: "로젤린",
  atom_contexts: [{ node_id: "11111111-2222-3333-4444-555555555555" }],
  default_preset: "codex-sol",
  aliases: [{ id: "roselin_codex" }],
  has_portrait: true,
  portrait_mime: "image/png",
  portrait_size: 4,
  portrait_sha256: "a".repeat(64),
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
      atomContexts: [],
      defaultPreset: null,
      aliases: [],
      expectedVersion: 4,
    })).rejects.toBeInstanceOf(AgentProfileVersionConflictError);
    expect(conflict.queries[0]).toContain("AND version =");
  });

  it("returns portrait bytes only from the portrait read boundary", async () => {
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const { repository } = harness([[{ portrait_blob: body, portrait_mime: "image/png", portrait_sha256: "b".repeat(64), version: 3 }]]);

    await expect(repository.getPortrait("roselin")).resolves.toEqual({
      body,
      mime: "image/png",
      sha256: "b".repeat(64),
      version: 3,
    });
  });

  it("treats the pre-migration undefined table as an empty dual-read source", async () => {
    const undefinedTable = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const sql = (() => { throw undefinedTable; }) as unknown as LivePostgresSql;
    Object.assign(sql, { json: (value: unknown) => value });
    const repository = createLiveAgentProfileRepository({
      resolveSql: async () => sql,
      close: async () => undefined,
    });

    await expect(repository.list()).resolves.toEqual([]);
    await expect(repository.get("roselin")).resolves.toBeNull();
    await expect(repository.getPortrait("roselin")).resolves.toBeNull();
  });
});
