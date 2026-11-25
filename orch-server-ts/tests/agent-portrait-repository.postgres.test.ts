import { spawnSync } from "node:child_process";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createLiveAgentPortraitRepository } from "../src/runtime/live_agent_portrait_repository.js";
import type { LivePostgresSql } from "../src/runtime/live_db_sql.js";
import {
  createFullSchemaPostgresHarness,
  type FullSchemaPostgresHarness,
} from "./board_yjs_postgres_harness.js";

const hasPostgres = Boolean(process.env.TEST_DATABASE_URL?.trim())
  || spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
const describePostgres = hasPostgres ? describe : describe.skip;

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("pg")]);
const sha = "a".repeat(64);
const write = (agentId: string, body = png) => ({ agentId, body, mime: "image/png" as const, sha256: sha });

describePostgres("central agent portrait store (PostgreSQL)", () => {
  let harness: FullSchemaPostgresHarness;
  const sql = () => harness.sql as unknown as LivePostgresSql;
  const create = () => createLiveAgentPortraitRepository({ resolveSql: async () => sql(), close: async () => undefined });

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
  }, 120_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  beforeEach(async () => {
    await harness.sql`DELETE FROM agent_portraits`;
    await harness.sql`DELETE FROM agent_profiles`;
  });

  it("moves agent_profiles portrait bytes once and leaves existing rows alone", async () => {
    await harness.sql`
      INSERT INTO agent_profiles (agent_id, name, portrait_blob, portrait_mime, portrait_sha256)
      VALUES ('roselin', 'r', ${png}, 'image/png', ${sha}),
             ('keke', 'k', ${png}, 'image/png', ${sha}),
             ('remiel', 'm', NULL, NULL, NULL)`;
    await harness.sql`
      INSERT INTO agent_portraits (agent_id, source) VALUES ('keke', 'upload')`;

    const first = create();
    await first.ready();

    expect(first.summary("roselin")).toMatchObject({ sha256: sha, byteSize: png.length });
    expect(first.summary("keke")).toBeNull();
    expect(first.hasRecord("keke")).toBe(true);
    expect(first.hasRecord("remiel")).toBe(false);
    const rows = await harness.sql`SELECT agent_id, source FROM agent_portraits ORDER BY agent_id`;
    expect(rows.map((row) => [row.agent_id, row.source])).toEqual([["keke", "upload"], ["roselin", "profile"]]);

    const second = create();
    await second.ready();
    const again = await harness.sql`SELECT count(*)::int AS count FROM agent_portraits`;
    expect(again[0]?.count).toBe(2);
    expect((await second.get("roselin"))?.body.equals(png)).toBe(true);
  });

  it("seeds only when no row exists, and upload overwrites a deletion marker", async () => {
    const store = create();
    await store.ready();

    expect(await store.seedFromNode(write("blossom"))).toBe(true);
    expect(await store.seedFromNode(write("blossom", Buffer.concat([png, Buffer.from("2")])))).toBe(false);
    expect((await store.get("blossom"))?.byteSize).toBe(png.length);

    await store.remove("blossom");
    expect(store.summary("blossom")).toBeNull();
    expect(await store.seedFromNode(write("blossom"))).toBe(false);
    const marker = await harness.sql`SELECT portrait_blob IS NULL AS empty, byte_size FROM agent_portraits WHERE agent_id = 'blossom'`;
    expect(marker[0]).toMatchObject({ empty: true, byte_size: null });

    await store.put(write("blossom"));
    expect(store.summary("blossom")).toMatchObject({ byteSize: png.length });
    const reloaded = create();
    await reloaded.ready();
    expect(reloaded.list().map((entry) => entry.agentId)).toEqual(["blossom"]);
  });
});
