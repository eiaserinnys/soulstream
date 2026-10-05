import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startPostgresTestContainer } from "../../packages/db-schema/scripts/postgres-test-container.mjs";
import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { SessionReadRepository } from "../src/control_plane/repositories/session_read_repository.js";
import { ModelPresetAvailabilityService } from "../src/model/model_preset_availability.js";
import {
  PersistentSessionSettingsService,
} from "../src/session/persistent_session_settings_service.js";
import { registerPersistentSessionSettingsRoutes } from "../src/session/persistent_session_settings_routes.js";
import { executeCreateSessionRoute } from "../src/session/session_command_routes.js";
import { SessionResourceAccessError } from "../src/session/session_resource_access.js";
import { createHarnessCore } from "./session-action-command-test-helpers.js";

/**
 * PAS settings API against a real PostgreSQL schema.
 *
 * Real: schema.sql (session_apply_metadata_entry / session_rename), the orch repository, service,
 * routes, session command router, node registry and command bridge, the model-preset availability
 * service, and the worker's PersistentSessionControl + session command handlers + task hydration.
 * Mocked: the model catalog the worker resolves against, the transport socket, the profile catalog,
 * folder access policy, and the worker's session-creation runtime (it only inserts the ordinary row a
 * real create would register).
 */

const hasDocker = spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
const describePostgres = hasDocker ? describe : describe.skip;

const NODE_ID = "eiaserinnys";
const PAS_AGENT = "seosoyoung-pas";

const NODE_PRESETS = [
  { id: "claude-opus", label: "Opus", backend: "claude", available: true, usage_provider: null,
    supported_efforts: ["low", "medium", "high"], default_effort: "high" },
  { id: "claude-sonnet", label: "Sonnet", backend: "claude", available: true, usage_provider: null,
    supported_efforts: ["low", "medium", "high"], default_effort: "medium" },
  { id: "codex-6.1-sol", label: "Sol", backend: "codex", available: true, usage_provider: null,
    supported_efforts: ["medium", "high"], default_effort: "high" },
];

type Json = Record<string, unknown>;

describePostgres("PAS settings API on PostgreSQL", () => {
  let sql: ReturnType<typeof postgres>;
  let stopContainer: () => void;
  let app: FastifyInstance;

  // One record of what the fake worker saw, reset per test.
  const metadataWrites: Array<{ type: string; replaceExistingType: string | null; waitForAck: boolean }> = [];
  const failOnce = new Set<string>();
  const createdByRuntime: Array<Json & { ordinaryAtCreate: boolean }> = [];
  const tasks = new Map<string, unknown>();

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
    app = await buildApp();
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

  async function buildApp(): Promise<FastifyInstance> {
    const worker = await loadWorker();
    const { registry, transports, router, bridge } = createHarnessCore({
      findSessionOwnerNodeId: async (sessionId) =>
        (await sql<Array<{ node_id: string | null }>>`SELECT node_id FROM sessions WHERE session_id = ${sessionId}`)[0]?.node_id ?? null,
    });
    const { node } = registry.registerNode({
      type: "node_register",
      node_id: NODE_ID,
      host: "127.0.0.1",
      port: 4105,
      agents: [{ id: PAS_AGENT, name: "서소영 (PAS)", backend: "claude" }],
      capabilities: { max_concurrent: 4 },
      supported_backends: ["claude", "codex"],
      model_presets: NODE_PRESETS,
    } as never);

    const logger = { warn: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined };
    const catalog = {
      resolve: (id: string) => {
        const preset = NODE_PRESETS.find((candidate) => candidate.id === id);
        if (!preset) throw new Error(`Unknown model preset: ${id}`);
        return { ...preset, model: `${id}-model`, env: {} };
      },
    };
    const control = new worker.PersistentSessionControl({
      getTask: (id: string) => tasks.get(id),
      loadEvictedTask: async (id: string) => {
        const row = (await sql`SELECT * FROM sessions WHERE session_id = ${id}`)[0];
        return row ? worker.hydrateEvictedTaskFromSessionRow(row, logger) : null;
      },
      rememberTask: (task: { agentSessionId: string }) => tasks.set(task.agentSessionId, task),
      persistence: {
        // Same SQL the orch event ingress applies for a metadata effect; resolving == ACK.
        enqueueMetadataEffect: async (
          sessionId: string,
          entry: { type: string },
          options: { replaceExistingType?: string; waitForAck?: boolean },
        ) => {
          if (failOnce.delete(entry.type)) throw new Error(`metadata ACK lost for ${entry.type}`);
          await sql`SELECT session_apply_metadata_entry(
            ${sessionId}, ${JSON.stringify(entry)}, ${options.replaceExistingType ?? null}, now())`;
          metadataWrites.push({
            type: entry.type,
            replaceExistingType: options.replaceExistingType ?? null,
            waitForAck: options.waitForAck === true,
          });
          return 1;
        },
      },
      modelCatalog: catalog,
      resolveCurrentBackend: (task: { modelPresetBackend?: string; modelPreset?: string }) =>
        task.modelPresetBackend ?? (task.modelPreset ? catalog.resolve(task.modelPreset).backend : undefined),
    });
    const runtime = {
      async createSession(params: Json) {
        const id = String(params.agentSessionId);
        await sql`
          INSERT INTO sessions (session_id, node_id, session_type, status, prompt, agent_id, model_preset, model,
                                reasoning_effort, folder_id, metadata, created_at, updated_at)
          VALUES (${id}, ${NODE_ID}, 'claude', 'completed', ${String(params.prompt)}, ${String(params.profileId)},
                  ${String(params.modelPreset)}, ${`${String(params.modelPreset)}-model`},
                  ${typeof params.reasoningEffort === "string" ? params.reasoningEffort : "auto"},
                  ${typeof params.folderId === "string" ? params.folderId : null}, '[]'::jsonb, now(), now())`;
        const row = (await sql`SELECT metadata FROM sessions WHERE session_id = ${id}`)[0]!;
        // The first turn starts before any PAS marker exists: the session must still be an ordinary one here.
        createdByRuntime.push({ ...params, ordinaryAtCreate: !JSON.stringify(row.metadata).includes("persistent_session") });
        return { agentSessionId: id, creationWarnings: [] };
      },
    };
    const reply = (data: unknown) =>
      registry.receiveNodeMessage({ nodeId: NODE_ID, connectionId: node.connectionId } as never, data as never);
    const handlers = worker.createSessionCommandFamily({
      send: async (data: unknown) => reply(data),
      logger,
      taskManager: { persistentSessions: control, cancelTask: async () => false, acknowledgeReview: async () => "not_found" },
      taskRuntimeCommands: runtime,
      sessionListCommands: {},
    });
    transports.attach({
      nodeId: NODE_ID,
      connectionId: node.connectionId,
      transport: {
        send: (data: string) => {
          const command = JSON.parse(data) as { type: string; requestId: string };
          void (async () => {
            try {
              await handlers[command.type]!(command);
            } catch (error) {
              // Mirrors CommandDispatcher.dispatch: coded input errors keep their code, the rest is a handler error.
              const coded = error instanceof worker.CommandDispatchError ? error : undefined;
              reply({
                type: "error",
                requestId: command.requestId,
                command_type: command.type,
                message: coded ? coded.message : `Handler error: ${(error as Error).message}`,
                ...(coded?.code ? { code: coded.code } : {}),
              });
            }
          })();
        },
      },
    } as never);

    const presets = new ModelPresetAvailabilityService(registry, { getSummary: () => ({ nodes: [] }) as never });
    const folderOf = async (sessionId: string) =>
      (await sql<Array<{ folder_id: string | null }>>`SELECT folder_id FROM sessions WHERE session_id = ${sessionId}`)[0]?.folder_id ?? null;
    const denyHidden = (folderId: string | null) => {
      if (folderId === "f-hidden") throw new SessionResourceAccessError("SESSION_ACCESS_DENIED", "Folder access denied", 403);
    };
    const commands = { router, bridge, timeoutMs: 5_000 };
    const service = new PersistentSessionSettingsService({
      reads: async () => new SessionReadRepository(sql as unknown as SqlClient),
      access: {
        resolveAccess: async () => ({ restricted: false, allowedFolderIds: [] }) as never,
        requireSessionAccess: async ({ sessionId }) => denyHidden(await folderOf(sessionId)),
        requireFolderAccess: async ({ folderId }) => denyHidden(folderId),
      },
      catalog: {
        // Same SQL as the live catalog provider's renameSession.
        renameSession: async (sessionId, displayName) => {
          await sql`SELECT session_rename(${sessionId}, ${displayName})`;
        },
      },
      commands,
      createSession: (request, body, log) =>
        executeCreateSessionRoute({ ...commands, modelPresetAvailability: presets }, request, body, log),
      presets,
      profiles: {
        listAgentProfiles: async (nodeId) =>
          registry.getConnectedNode(nodeId) === undefined ? undefined : { [PAS_AGENT]: { name: "서소영 (PAS)" } },
      },
    });
    const fastify = Fastify();
    registerPersistentSessionSettingsRoutes(fastify, { service });
    await fastify.ready();
    return fastify;
  }

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
      },
    });
    // The saved entry predates show_jev_candidates: it reads as true without being rewritten.
    expect(list.body.sessions![2]).toMatchObject({
      settings: {
        default_model: { model_preset: "claude-sonnet", reasoning_effort: "low" },
        fallback_model: { model_preset: "codex-6.1-sol", reasoning_effort: "high" },
        show_generation_separator: false,
        show_jev_candidates: true,
      },
    });
    expect(JSON.stringify(await metadataOf("pas-late"))).not.toContain("show_jev_candidates");
    expect(list.body.create_defaults).toEqual({
      node_id: NODE_ID,
      preferred_agent_id: PAS_AGENT,
      settings: {
        default_model: { model_preset: "claude-opus", reasoning_effort: "high" },
        fallback_model: { model_preset: "codex-6.1-sol", reasoning_effort: "high" },
        show_generation_separator: true,
        show_character: true,
        show_jev_candidates: true,
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

type WorkerModules = {
  PersistentSessionControl: new (deps: Json) => { applySettings: unknown };
  createSessionCommandFamily: (deps: Json) => Record<string, (command: unknown) => Promise<void>>;
  hydrateEvictedTaskFromSessionRow: (row: unknown, logger: unknown) => unknown;
  CommandDispatchError: new (message: string, code?: string) => Error & { code?: string };
};

async function loadWorker(): Promise<WorkerModules> {
  const [control, family, hydration, commandFamily] = await Promise.all([
    vi.importActual<Json>("../../soul-server-ts/src/task/persistent_session_control.js"),
    vi.importActual<Json>("../../soul-server-ts/src/upstream/session_command_family.js"),
    vi.importActual<Json>("../../soul-server-ts/src/task/task_evicted_hydration.js"),
    vi.importActual<Json>("../../soul-server-ts/src/upstream/command_family.js"),
  ]);
  return {
    PersistentSessionControl: control.PersistentSessionControl as WorkerModules["PersistentSessionControl"],
    createSessionCommandFamily: family.createSessionCommandFamily as WorkerModules["createSessionCommandFamily"],
    hydrateEvictedTaskFromSessionRow: hydration.hydrateEvictedTaskFromSessionRow as WorkerModules["hydrateEvictedTaskFromSessionRow"],
    CommandDispatchError: commandFamily.CommandDispatchError as WorkerModules["CommandDispatchError"],
  };
}

async function waitForPostgres(client: ReturnType<typeof postgres>): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await client`SELECT 1`;
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
