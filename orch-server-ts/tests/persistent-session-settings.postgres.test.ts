import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { startPostgresTestContainer } from "../../packages/db-schema/scripts/postgres-test-container.mjs";
import {
  NODE_ID,
  PAS_AGENT,
  buildPersistentSettingsApp,
  createPersistentSettingsState,
  waitForPostgres,
} from "./persistent-session-settings-world.js";

// PAS settings API against a real PostgreSQL schema. The world (real orch service/routes/router/registry,
// real worker control and handlers, mocked model catalog and transport socket) lives in
// persistent-session-settings-world.ts.

const hasDocker = spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
const describePostgres = hasDocker ? describe : describe.skip;

type Json = Record<string, unknown>;

describePostgres("PAS settings API on PostgreSQL", () => {
  let sql: ReturnType<typeof postgres>;
  let stopContainer: () => void;
  let app: FastifyInstance;
  const state = createPersistentSettingsState();
  const { metadataWrites, failOnce, createdByRuntime, tasks } = state;

  beforeAll(async () => {
    const container = startPostgresTestContainer({
      user: "pas_settings_test",
      password: "pas_settings_test",
      database: "pas_settings_test_db",
    });
    stopContainer = container.stop;
    sql = postgres(
      `postgres://pas_settings_test:pas_settings_test@127.0.0.1:${container.port}/pas_settings_test_db`,
      { max: 4, onnotice: () => undefined },
    );
    await waitForPostgres(sql);
    await sql.unsafe(readFileSync(fileURLToPath(new URL("../../packages/db-schema/sql/schema.sql", import.meta.url)), "utf8"));
    app = await buildPersistentSettingsApp(sql, state);
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await sql?.end({ timeout: 2 });
    stopContainer?.();
  });

  beforeEach(async () => {
    await sql`DELETE FROM events`;
    await sql`UPDATE sessions SET predecessor_session_id = NULL`;
    await sql`DELETE FROM sessions`;
    await sql`DELETE FROM folders`;
    metadataWrites.length = 0;
    failOnce.clear();
    createdByRuntime.length = 0;
    tasks.clear();
  });

  const call = async (method: "GET" | "PUT" | "POST", url: string, payload?: unknown) => {
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as never }) });
    return { status: response.statusCode, body: response.json() as Json & { error?: Json; session?: Json; sessions?: Json[] } };
  };

  async function seedSession(input: {
    id: string;
    displayName?: string | null;
    nodeId?: string;
    folderId?: string | null;
    modelPreset?: string;
    effort?: string;
    createdAt?: string;
    updatedAt?: string;
    metadata?: unknown[];
  }) {
    await sql`
      INSERT INTO sessions (session_id, display_name, node_id, folder_id, session_type, status, agent_id,
                            model_preset, model, reasoning_effort, metadata, created_at, updated_at)
      VALUES (${input.id}, ${input.displayName ?? null}, ${input.nodeId ?? NODE_ID}, ${input.folderId ?? null},
              'claude', 'completed', ${PAS_AGENT}, ${input.modelPreset ?? "claude-opus"},
              ${`${input.modelPreset ?? "claude-opus"}-model`}, ${input.effort ?? "high"},
              ${sql.json((input.metadata ?? []) as never)},
              ${input.createdAt ?? "2026-09-01T00:00:00Z"}, ${input.updatedAt ?? "2026-09-01T00:00:00Z"})`;
  }

  const persistentOn = { type: "persistent_session", value: { enabled: true, updated_at: "2026-09-01T00:00:00Z" } };
  const metadataOf = async (id: string) =>
    (await sql<Array<{ metadata: Array<{ type: string; value: Json }> }>>`SELECT metadata FROM sessions WHERE session_id = ${id}`)[0]!.metadata;

  it("saves name and default model, shows them on the next GET, and keeps other metadata types", async () => {
    await seedSession({
      id: "pas-edit", displayName: "old name",
      metadata: [
        { type: "caller_info", value: { source: "agent", agent_id: "seosoyoung" } },
        persistentOn,
        { type: "persistent_generation", value: {
          number: 3, backend_session_id: "native-3", started_at: "2026-09-02T00:00:00Z",
          first_call: { generation: 3, input_tokens: 1000, cached_input_tokens: 900, model_preset: "claude-opus",
            model: "claude-opus-4", measured_at: "2026-09-02T00:01:00Z" },
          pending: null } },
      ],
    });

    const saved = await call("PUT", "/api/persistent-sessions/pas-edit", {
      display_name: "  새 이름  ",
      settings: { default_model: { model_preset: "claude-sonnet", reasoning_effort: null } },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.model_change).toBe("next_execution_start");
    expect(saved.body.session).toMatchObject({
      session_id: "pas-edit",
      display_name: "새 이름",
      agent_name: "서소영 (PAS)",
      persistent: true,
      settings: { default_model: { model_preset: "claude-sonnet", reasoning_effort: "medium" } },
      runtime: {
        current_model: { model_preset: "claude-opus", reasoning_effort: "high" },
        pending: { target_model_preset: "claude-sonnet", target_reasoning_effort: "medium" },
      },
    });

    const reread = await call("GET", "/api/persistent-sessions/pas-edit");
    expect(reread.body.session).toEqual(saved.body.session);

    const metadata = await metadataOf("pas-edit");
    expect(metadata.filter((entry) => entry.type === "persistent_settings")).toHaveLength(1);
    expect(metadata.find((entry) => entry.type === "caller_info")?.value).toMatchObject({ agent_id: "seosoyoung" });
    expect(metadata.find((entry) => entry.type === "persistent_generation")?.value).toMatchObject({
      number: 3,
      backend_session_id: "native-3",
      first_call: { input_tokens: 1000, cached_input_tokens: 900 },
      pending: { target_model_preset: "claude-sonnet", reason: "settings" },
    });
    expect(metadataWrites).toContainEqual({ type: "persistent_settings", replaceExistingType: "persistent_settings", waitForAck: true });

    // Same input again: the target is already pending, so no second change request is written.
    const generationWrites = () => metadataWrites.filter((write) => write.type === "persistent_generation").length;
    expect(generationWrites()).toBe(1);
    const again = await call("PUT", "/api/persistent-sessions/pas-edit", {
      settings: { default_model: { model_preset: "claude-sonnet", reasoning_effort: null } },
    });
    expect(again.status).toBe(200);
    expect(again.body.model_change).toBe("none");
    expect(generationWrites()).toBe(1);

    // Partial saves keep what they do not mention, including a saved false toggle.
    const jevOff = await call("PUT", "/api/persistent-sessions/pas-edit", { settings: { show_jev_candidates: false } });
    expect(jevOff.body.session).toMatchObject({
      settings: { default_model: { model_preset: "claude-sonnet", reasoning_effort: "medium" }, show_jev_candidates: false },
    });
    const characterOff = await call("PUT", "/api/persistent-sessions/pas-edit", { settings: { show_character: false } });
    expect(characterOff.body.session).toMatchObject({
      settings: {
        default_model: { model_preset: "claude-sonnet", reasoning_effort: "medium" },
        show_jev_candidates: false,
        show_character: false,
        show_generation_separator: true,
      },
    });
    const usageAndMotionOff = await call("PUT", "/api/persistent-sessions/pas-edit", {
      settings: { show_turn_usage: false, animate_character: false },
    });
    expect(usageAndMotionOff.body.session).toMatchObject({
      settings: {
        default_model: { model_preset: "claude-sonnet", reasoning_effort: "medium" },
        show_jev_candidates: false,
        show_character: false,
        show_generation_separator: true,
        show_turn_usage: false,
        animate_character: false,
      },
    });
    const rereadUsage = await call("GET", "/api/persistent-sessions/pas-edit");
    expect(rereadUsage.body.session!.settings)
      .toMatchObject({ show_turn_usage: false, animate_character: false });
    const unknownSetting = await call("PUT", "/api/persistent-sessions/pas-edit", { settings: { future_setting: true } });
    expect(unknownSetting.status).toBe(422);
  });

  it("fills a missing model change on re-save after the change request step failed", async () => {
    await seedSession({ id: "pas-retry", displayName: "retry", metadata: [persistentOn] });
    failOnce.add("persistent_generation");
    const body = { settings: { default_model: { model_preset: "claude-sonnet", reasoning_effort: null } } };

    const failed = await call("PUT", "/api/persistent-sessions/pas-retry", body);
    expect(failed.status).toBe(503);
    const partial = await call("GET", "/api/persistent-sessions/pas-retry");
    expect(partial.body.session).toMatchObject({
      settings: { default_model: { model_preset: "claude-sonnet" } },
      runtime: { pending: null },
    });

    const retried = await call("PUT", "/api/persistent-sessions/pas-retry", body);
    expect(retried.status).toBe(200);
    expect(retried.body.model_change).toBe("next_execution_start");
    expect(retried.body.session).toMatchObject({ runtime: { pending: { target_model_preset: "claude-sonnet" } } });
    expect(createdByRuntime).toHaveLength(0);
  });

  it("lists every accessible PAS behind hundreds of ordinary sessions and reports the access and owner errors", async () => {
    await sql`
      INSERT INTO sessions (session_id, node_id, session_type, status, metadata, created_at, updated_at)
      SELECT 'ordinary-' || g, ${NODE_ID}, 'claude', 'completed', '[]'::jsonb,
             '2026-09-10T00:00:00Z'::timestamptz + g * interval '1 minute',
             '2026-10-01T00:00:00Z'::timestamptz + g * interval '1 minute'
      FROM generate_series(1, 250) g`;
    await sql`INSERT INTO folders (id, name, parent_folder_id, settings) VALUES
      ('f-hidden', 'hidden', NULL, '{}'), ('f-open', 'open', NULL, '{}')`;
    await seedSession({ id: "pas-legacy", displayName: "legacy", createdAt: "2026-09-01T00:00:00Z", metadata: [persistentOn] });
    await seedSession({
      id: "pas-late", displayName: "late", modelPreset: "claude-sonnet", effort: "low", folderId: "f-open",
      createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z",
      metadata: [persistentOn, { type: "persistent_settings", value: {
        default_model: { model_preset: "claude-sonnet", reasoning_effort: "low" },
        fallback_model: { model_preset: "codex-6.1-sol", reasoning_effort: "high" },
        show_generation_separator: false, show_character: true } }],
    });
    await seedSession({ id: "pas-hidden", folderId: "f-hidden", createdAt: "2026-09-03T00:00:00Z", metadata: [persistentOn] });
    await seedSession({
      id: "released", createdAt: "2026-09-04T00:00:00Z",
      metadata: [{ type: "persistent_session", value: { enabled: false } }],
    });
    await seedSession({ id: "pas-ghost-node", nodeId: "ghost-node", createdAt: "2026-09-05T00:00:00Z", metadata: [persistentOn] });

    const list = await call("GET", "/api/persistent-sessions");
    expect(list.status).toBe(200);
    expect(list.body.sessions!.map((session) => session.session_id)).toEqual(["pas-legacy", "pas-ghost-node", "pas-late"]);
    expect(list.body.total).toBe(3);
    expect(list.body.sessions![0]).toMatchObject({
      settings: {
        default_model: { model_preset: "claude-opus", reasoning_effort: "high" },
        fallback_model: null, show_generation_separator: true, show_character: true, show_jev_candidates: true,
        show_turn_usage: true, animate_character: true,
      },
    });
    // The saved entry predates show_jev_candidates and the new fields: all read as true without being rewritten.
    expect(list.body.sessions![2]).toMatchObject({
      settings: {
        default_model: { model_preset: "claude-sonnet", reasoning_effort: "low" },
        fallback_model: { model_preset: "codex-6.1-sol", reasoning_effort: "high" },
        show_generation_separator: false,
        show_jev_candidates: true,
        show_turn_usage: true,
        animate_character: true,
      },
    });
    expect(JSON.stringify(await metadataOf("pas-late"))).not.toContain("show_jev_candidates");
    expect(JSON.stringify(await metadataOf("pas-late"))).not.toContain("show_turn_usage");
    expect(JSON.stringify(await metadataOf("pas-late"))).not.toContain("animate_character");
    expect(list.body.create_defaults).toEqual({
      node_id: NODE_ID,
      preferred_agent_id: PAS_AGENT,
      settings: {
        default_model: { model_preset: "claude-opus", reasoning_effort: "high" },
        fallback_model: { model_preset: "codex-6.1-sol", reasoning_effort: "high" },
        show_generation_separator: true,
        show_character: true,
        show_jev_candidates: true,
        show_turn_usage: true,
        animate_character: true,
      },
      initial_instruction: "새 영구 에이전트 세션입니다. 도구를 쓰지 말고 짧게 인사한 뒤 다음 지시를 기다려 주십시오.",
      unavailable_reason: null,
    });

    expect((await call("GET", "/api/persistent-sessions/released")).body.session).toMatchObject({ persistent: false });
    expect((await call("GET", "/api/persistent-sessions/no-such-session")).status).toBe(404);
    expect((await call("GET", "/api/persistent-sessions/pas-hidden")).status).toBe(403);
    const ordinary = await call("PUT", "/api/persistent-sessions/ordinary-1", { display_name: "x" });
    expect(ordinary.status).toBe(409);
    expect(ordinary.body.error).toMatchObject({ code: "NOT_PERSISTENT" });
    const ghost = await call("PUT", "/api/persistent-sessions/pas-ghost-node", { display_name: "x" });
    expect(ghost.status).toBe(503);
    expect(ghost.body.error).toMatchObject({ code: "NODE_UNAVAILABLE" });
  });

  it("creates through the ordinary create path, then registers the session as PAS", async () => {
    await sql`INSERT INTO folders (id, name, parent_folder_id, settings) VALUES ('f-open', 'open', NULL, '{}')`;

    const created = await call("POST", "/api/persistent-sessions", {
      display_name: "새 PAS", agent_id: PAS_AGENT, folder_id: "f-open", initial_instruction: "",
      settings: { default_model: { model_preset: "claude-opus", reasoning_effort: null } },
    });
    expect(created.status).toBe(201);
    expect(created.body.creation).toBe("started");
    expect(created.body.warnings).toEqual([]);

    expect(createdByRuntime).toHaveLength(1);
    expect(createdByRuntime[0]).toMatchObject({
      ordinaryAtCreate: true,
      profileId: PAS_AGENT,
      modelPreset: "claude-opus",
      reasoningEffort: "high",
      folderId: "f-open",
    });
    expect(String(createdByRuntime[0]!.prompt)).toContain(
      "새 영구 에이전트 세션입니다. 도구를 쓰지 말고 짧게 인사한 뒤 다음 지시를 기다려 주십시오.",
    );

    const session = created.body.session!;
    expect(session).toMatchObject({
      display_name: "새 PAS",
      node_id: NODE_ID,
      folder_id: "f-open",
      agent_id: PAS_AGENT,
      persistent: true,
      settings: {
        default_model: { model_preset: "claude-opus", reasoning_effort: "high" },
        fallback_model: { model_preset: "codex-6.1-sol", reasoning_effort: "high" },
        show_generation_separator: true,
        show_character: true,
        show_jev_candidates: true,
      },
      runtime: { pending: null },
    });
    const list = await call("GET", "/api/persistent-sessions");
    expect(list.body.sessions!.map((entry) => entry.session_id)).toEqual([session.session_id]);
    // The first run already uses the default model, so no model change request exists.
    expect(metadataWrites.filter((write) => write.type === "persistent_generation")).toHaveLength(0);
  });

  it("keeps the created session when registration fails and registers it later without creating another", async () => {
    failOnce.add("persistent_settings");
    const failed = await call("POST", "/api/persistent-sessions", {
      display_name: "복구 PAS", agent_id: PAS_AGENT, initial_instruction: "첫 인사",
      settings: { default_model: { model_preset: "claude-opus", reasoning_effort: null } },
    });
    expect(failed.status).toBe(503);
    expect(failed.body.error).toMatchObject({ code: "PERSISTENT_REGISTRATION_FAILED" });
    const createdSession = failed.body.created_session as { session_id: string; display_name: string };
    expect(createdSession.display_name).toBe("복구 PAS");
    expect(createdByRuntime).toHaveLength(1);

    const row = (await sql`SELECT display_name, metadata FROM sessions WHERE session_id = ${createdSession.session_id}`)[0]!;
    expect(row.display_name).toBe("복구 PAS");
    expect(JSON.stringify(row.metadata)).not.toContain("persistent_session");
    expect((await call("GET", "/api/persistent-sessions")).body.sessions).toEqual([]);

    const registered = await call("PUT", `/api/persistent-sessions/${createdSession.session_id}`, {
      enabled: true,
      settings: { default_model: { model_preset: "claude-opus", reasoning_effort: null } },
    });
    expect(registered.status).toBe(200);
    expect(registered.body.session).toMatchObject({ session_id: createdSession.session_id, persistent: true });
    expect(createdByRuntime).toHaveLength(1);
    expect((await call("GET", "/api/persistent-sessions")).body.sessions!.map((entry) => entry.session_id))
      .toEqual([createdSession.session_id]);
  });

  it("releases only the marker: settings and history stay, and the list drops the session", async () => {
    const settings = { type: "persistent_settings", value: {
      default_model: { model_preset: "claude-opus", reasoning_effort: "high" },
      fallback_model: null, show_generation_separator: true, show_character: true } };
    await seedSession({ id: "pas-release", displayName: "release me", metadata: [persistentOn, settings] });
    await sql`SELECT event_append('pas-release', 'user_message', '{"text":"hello"}', 'hello', now())`;

    const mixed = await call("PUT", "/api/persistent-sessions/pas-release", { enabled: false, display_name: "x" });
    expect(mixed.status).toBe(422);
    expect(metadataWrites).toHaveLength(0);

    const released = await call("PUT", "/api/persistent-sessions/pas-release", { enabled: false });
    expect(released.status).toBe(200);
    expect(released.body.session).toMatchObject({ persistent: false, display_name: "release me" });

    const metadata = await metadataOf("pas-release");
    expect(metadata.find((entry) => entry.type === "persistent_session")?.value).toMatchObject({ enabled: false });
    expect(metadata.find((entry) => entry.type === "persistent_settings")).toEqual(settings);
    expect(Number((await sql`SELECT COUNT(*) AS count FROM events WHERE session_id = 'pas-release'`)[0]!.count)).toBe(1);
    expect((await call("GET", "/api/persistent-sessions")).body.sessions).toEqual([]);
    expect((await call("GET", "/api/persistent-sessions/pas-release")).status).toBe(200);
  });
});
