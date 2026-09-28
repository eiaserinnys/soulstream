import { describe, expect, it } from "vitest";

import {
  ContextBundleVersionConflictError,
  createLiveContextBundleRepository,
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
  return { repository: createLiveContextBundleRepository(resolver), queries };
}

const row = {
  bundle_id: "people",
  description: "People context",
  atom_contexts: [{ node_id: "11111111-2222-3333-4444-555555555555" }],
  version: 2,
  created_at: new Date("2026-08-07T00:00:00.000Z"),
  updated_at: new Date("2026-08-07T01:00:00.000Z"),
};

describe("live context bundle repository", () => {
  it("maps bundle reads", async () => {
    const { repository, queries } = harness([[row], [row]]);

    await expect(repository.list()).resolves.toEqual([{
      bundleId: "people",
      description: "People context",
      atomContexts: row.atom_contexts,
      version: 2,
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T01:00:00.000Z",
    }]);
    await expect(repository.get("people")).resolves.toMatchObject({ bundleId: "people" });
    expect(queries[0]).toContain("ORDER BY bundle_id ASC");
  });

  it("inserts and updates with version CAS, and deletes only the expected version", async () => {
    const { repository, queries } = harness([[row], [{ ...row, version: 3 }], [{ bundle_id: "people" }]]);
    const write = {
      bundleId: "people",
      description: "People context",
      atomContexts: row.atom_contexts,
    };

    await expect(repository.put({ ...write, expectedVersion: null })).resolves.toMatchObject({
      bundleId: "people",
      version: 2,
    });
    await expect(repository.put({ ...write, expectedVersion: 2 })).resolves.toMatchObject({
      bundleId: "people",
      version: 3,
    });
    await expect(repository.delete("people", 3)).resolves.toBe(true);

    expect(queries[0]).toContain("INSERT INTO context_bundles");
    expect(queries[1]).toContain("WHERE bundle_id = ? AND version = ?");
    expect(queries[2]).toContain("DELETE FROM context_bundles");
  });

  it("reports a stale version and treats an undefined table as an empty read source", async () => {
    const conflict = harness([[]]);
    await expect(conflict.repository.put({
      bundleId: "people",
      description: "People context",
      atomContexts: [],
      expectedVersion: 4,
    })).rejects.toBeInstanceOf(ContextBundleVersionConflictError);

    const undefinedTable = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const sql = (() => { throw undefinedTable; }) as unknown as LivePostgresSql;
    Object.assign(sql, { json: (value: unknown) => value });
    const repository = createLiveContextBundleRepository({
      resolveSql: async () => sql,
      close: async () => undefined,
    });
    await expect(repository.list()).resolves.toEqual([]);
    await expect(repository.get("people")).resolves.toBeNull();
  });
});
