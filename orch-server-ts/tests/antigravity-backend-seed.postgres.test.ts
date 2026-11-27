import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { seedAntigravityBackend } from "../src/settings/antigravity_backend_settings.js";
import { openIsolatedPostgres } from "./isolated_postgres_harness.js";

const AGY_PRESETS = ["agy-seed-preset-a", "agy-seed-preset-b"];

describe("Antigravity switch seed on the production schema", () => {
  let sql: ReturnType<typeof postgres>, stop: () => Promise<void>;
  const info = vi.fn();
  const seed = () => seedAntigravityBackend(sql as never, AGY_PRESETS, info);
  const stored = async () => (await sql<Array<{ value: { enabled: boolean }; version: string; updated_by: string }>>`
    SELECT value, version, updated_by FROM system_settings WHERE setting_key='antigravity_backend'`)[0];

  beforeAll(async () => {
    const db = await openIsolatedPostgres({ max: 2 });
    sql = db.sql;
    stop = db.cleanup;
  }, 120_000);
  afterAll(async () => { await stop?.(); });
  beforeEach(async () => {
    info.mockClear();
    await sql`DELETE FROM system_settings WHERE setting_key='antigravity_backend'`;
    await sql`DELETE FROM sessions`;
    await sql`DELETE FROM agent_profiles`;
  });

  it("seeds off on an empty database", async () => {
    await seed();
    expect(await stored()).toMatchObject({ value: { enabled: false }, updated_by: "system:antigravity-seed" });
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("seeds on when a session already ran on an Antigravity preset", async () => {
    await sql`INSERT INTO sessions(session_id,node_id,agent_id,status,model_preset) VALUES ('s-claude','n','a','completed','other'),('s-agy','n','a','completed',${AGY_PRESETS[1]!})`;
    await seed();
    expect(await stored()).toMatchObject({ value: { enabled: true } });
  });

  it("seeds on when an agent profile defaults to an Antigravity preset", async () => {
    await sql`INSERT INTO agent_profiles(agent_id,name,default_preset) VALUES ('gem','Gem',${AGY_PRESETS[0]!})`;
    await seed();
    expect(await stored()).toMatchObject({ value: { enabled: true } });
  });

  it("leaves an existing row untouched", async () => {
    await sql`INSERT INTO system_settings(setting_key,value,version,updated_by) VALUES ('antigravity_backend',${sql.json({ enabled: false })},4,'admin@example.com')`;
    await sql`INSERT INTO agent_profiles(agent_id,name,default_preset) VALUES ('gem','Gem',${AGY_PRESETS[0]!})`;
    await seed();
    expect(await stored()).toMatchObject({ value: { enabled: false }, version: "4", updated_by: "admin@example.com" });
    expect(info).not.toHaveBeenCalled();
  });
});
