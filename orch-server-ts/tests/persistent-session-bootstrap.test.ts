import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { ServiceCaller } from "../src/auth/service_caller.js";
import { ModelPresetAvailabilityError } from "../src/model/model_preset_availability.js";
import type { SessionCreateRouteResponse } from "../src/session/session_create_route_response.js";
import { SessionResourceAccessError } from "../src/session/session_resource_access.js";
import { PERSISTENT_INITIAL_INSTRUCTION } from "@soulstream/wire-schema/conversation-visibility";
import { PersistentSessionSettingsService } from "../src/session/persistent_session_settings_service.js";
import { registerPersistentSessionSettingsRoutes } from "../src/session/persistent_session_settings_routes.js";
import { repositoryModelCatalog } from "./helpers/model_catalog.js";

// POST /api/persistent-sessions/bootstrap makes the default PAS through the ordinary create path.
// Fastify and fake deps only; no database.

const catalog = repositoryModelCatalog();
const PAS_AGENT = "install-pas";
const NODE = "worker-node";

type Json = Record<string, unknown>;

type Options = {
  enabled?: boolean;
  /** Persistent sessions the repository lists before the call. */
  existing?: Json[];
  /** Folders the caller may not see. */
  deniedFolders?: readonly string[];
  advertisedPresets?: readonly string[];
  profiles?: Record<string, { name?: string }> | null;
  callerId?: string | null;
  /** When set, createSession waits for this promise so a second request can overlap. */
  createGate?: Promise<void>;
  createStatus?: number;
};

function persistentRow(sessionId: string, folderId: string | null = null): Json {
  return {
    session_id: sessionId,
    display_name: sessionId,
    node_id: NODE,
    folder_id: folderId,
    agent_id: PAS_AGENT,
    model_preset: "claude-opus",
    model: "claude-opus-model",
    reasoning_effort: "high",
    metadata: [{ type: "persistent_session", value: { enabled: true } }],
    updated_at: new Date(0),
  };
}

function buildApp(options: Options = {}): {
  app: FastifyInstance;
  createBodies: Json[];
  sentSettings: Json[];
  renames: Array<{ sessionId: string; name: string }>;
  callerIdCalls: () => number;
  service: PersistentSessionSettingsService;
} {
  const createBodies: Json[] = [];
  const sentSettings: Json[] = [];
  const renames: Array<{ sessionId: string; name: string }> = [];
  const rows = new Map<string, Json>();
  const listed: Json[] = [...(options.existing ?? [])];
  let created = 0;
  let callerIdCalls = 0;
  const service = new PersistentSessionSettingsService({
    defaultExecutionNodeId: NODE,
    connectedNodeIds: () => [NODE],
    defaultPasAgentId: PAS_AGENT,
    ...(options.enabled === undefined ? {} : { bootstrapEnabled: options.enabled }),
    resolveCallerId: async () => {
      callerIdCalls += 1;
      return options.callerId === undefined ? "person@example.com" : options.callerId;
    },
    reads: async () => ({
      getSession: async (sessionId: string) => rows.get(sessionId) ?? null,
      listPersistentSessions: async () => listed,
    }),
    access: {
      resolveAccess: async () => ({ restricted: false, allowedFolderIds: [] }) as never,
      requireSessionAccess: async () => undefined,
      requireFolderAccess: async ({ folderId }: { folderId: string | null }) => {
        if (folderId !== null && options.deniedFolders?.includes(folderId)) {
          throw new SessionResourceAccessError("FOLDER_FORBIDDEN", "Forbidden", 403);
        }
      },
    },
    catalog: {
      renameSession: async (sessionId: string, name: string) => {
        renames.push({ sessionId, name });
      },
    },
    commands: {
      router: { routeExistingSessionPendingCommand: async (payload: Json) => payload as never },
      bridge: { sendPendingCommand: async (payload: Json) => {
        sentSettings.push(payload);
        const row = rows.get(String(payload.agentSessionId));
        if (row !== undefined && payload.enabled === true) listed.push(row);
        return { persistent: true, modelChange: "none" };
      } },
      timeoutMs: 1_000,
    },
    createSession: async (
      _request: FastifyRequest | ServiceCaller,
      body: Record<string, unknown>,
    ): Promise<SessionCreateRouteResponse> => {
      createBodies.push(body);
      await options.createGate;
      if (options.createStatus !== undefined && options.createStatus !== 201) {
        return { status: options.createStatus, body: { error: { code: "CREATE_REFUSED", message: "refused" } } };
      }
      const sessionId = `pas-bootstrap-${++created}`;
      rows.set(sessionId, {
        ...persistentRow(sessionId),
        display_name: null,
        metadata: [],
        node_id: typeof body.nodeId === "string" ? body.nodeId : NODE,
        agent_id: String(body.profile),
        model_preset: String(body.model_preset),
      });
      return { status: 201, body: { agentSessionId: sessionId } };
    },
    presets: {
      resolveStaticForNode: (_nodeId: string, presetId: string) => {
        if (options.advertisedPresets !== undefined && !options.advertisedPresets.includes(presetId)) {
          throw new ModelPresetAvailabilityError(
            "MODEL_PRESET_NOT_FOUND",
            `Model preset '${presetId}' is not advertised by node ${NODE}`,
          );
        }
        return {
          id: presetId,
          backend: presetId.startsWith("claude-") ? "claude" : "codex",
          available: true,
          supported_efforts: ["high", "medium"],
          default_effort: "high",
        };
      },
      requireAvailable: () => undefined as never,
    },
    profiles: { listAgentProfiles: async () =>
      options.profiles === null ? undefined : options.profiles ?? { [PAS_AGENT]: { name: "서소영 (PAS)" } } },
    modelCatalog: catalog,
  } as never);
  const app = Fastify();
  registerPersistentSessionSettingsRoutes(app, { service });
  return { app, createBodies, sentSettings, renames, callerIdCalls: () => callerIdCalls, service };
}

function post(app: FastifyInstance, payload?: unknown) {
  return app.inject({ method: "POST", url: "/api/persistent-sessions/bootstrap", ...(payload === undefined ? {} : { payload: payload as never }) });
}

describe("POST /api/persistent-sessions/bootstrap", () => {
  it("answers 409 bootstrap_disabled when the switch is off", async () => {
    const { app, createBodies } = buildApp({ enabled: false });
    const response = await post(app);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: { code: "bootstrap_disabled", message: "기본 영구 세션 만들기가 꺼져 있습니다." },
    });
    expect(createBodies).toEqual([]);
    await app.close();
  });

  it("answers 409 bootstrap_disabled when the switch was never given", async () => {
    const { app } = buildApp();
    expect((await post(app)).json()).toMatchObject({ error: { code: "bootstrap_disabled" } });
    await app.close();
  });

  it("returns the first listed session without creating when the caller already sees one", async () => {
    const { app, createBodies } = buildApp({
      enabled: true,
      existing: [persistentRow("pas-first"), persistentRow("pas-second")],
    });
    const response = await post(app, {});
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ created: false, session_id: "pas-first" });
    expect(createBodies).toEqual([]);
    await app.close();
  });

  it("ignores persistent sessions in folders the caller cannot see", async () => {
    const { app, createBodies } = buildApp({
      enabled: true,
      existing: [persistentRow("pas-hidden", "folder-denied")],
      deniedFolders: ["folder-denied"],
    });
    const response = await post(app);
    expect(response.statusCode).toBe(201);
    expect(createBodies).toHaveLength(1);
    await app.close();
  });

  it("answers 409 bootstrap_unavailable with the defaults' reason", async () => {
    const { app, createBodies } = buildApp({ enabled: true, profiles: null });
    const response = await post(app);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "bootstrap_unavailable",
        message: `노드 ${NODE}에 연결할 수 없어 프로필을 확인하지 못했습니다.`,
      },
    });
    expect(createBodies).toEqual([]);
    await app.close();
  });

  it("answers 409 bootstrap_unavailable when the node advertises none of the catalog models", async () => {
    const { app, createBodies } = buildApp({ enabled: true, advertisedPresets: ["gemini-4-carbon"] });
    const response = await post(app);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "bootstrap_unavailable" } });
    expect(createBodies).toEqual([]);
    await app.close();
  });

  it("answers 409 bootstrap_unavailable with the no-model message when the defaults hold no model and no reason", async () => {
    const { app, createBodies, service } = buildApp({ enabled: true });
    const defaults = await service.createDefaults();
    vi.spyOn(service, "createDefaults").mockResolvedValue({
      ...defaults,
      settings: { ...defaults.settings, default_model: { model_preset: null, reasoning_effort: null } },
      unavailable_reason: null,
    });
    const response = await post(app);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "bootstrap_unavailable",
        message: "쓸 수 있는 모델이 없습니다. 코딩 에이전트를 먼저 연결해 주십시오.",
      },
    });
    expect(createBodies).toEqual([]);
    await app.close();
  });

  it("creates through the ordinary create path and answers 201", async () => {
    const { app, createBodies, sentSettings, renames } = buildApp({
      enabled: true,
      advertisedPresets: ["claude-opus", "codex-6.2-sol"],
    });
    const response = await post(app);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ created: true, session_id: "pas-bootstrap-1" });
    expect(createBodies).toHaveLength(1);
    expect(createBodies[0]).toMatchObject({
      profile: PAS_AGENT,
      nodeId: NODE,
      model_preset: "claude-opus",
      reasoningEffort: "high",
      initial_instruction: PERSISTENT_INITIAL_INSTRUCTION,
    });
    expect(createBodies[0]).not.toHaveProperty("folderId");
    expect(renames).toEqual([{ sessionId: "pas-bootstrap-1", name: "서소영" }]);
    expect(sentSettings.at(-1)).toMatchObject({
      type: "set_persistent_session_settings",
      agentSessionId: "pas-bootstrap-1",
      enabled: true,
      settings: {
        default_model: { model_preset: "claude-opus", reasoning_effort: "high" },
        fallback_models: [{ model_preset: "codex-6.2-sol", reasoning_effort: "high" }],
      },
    });
    await app.close();
  });

  it("names the session PAS when the profile name is unknown", async () => {
    const { app, renames } = buildApp({ enabled: true, profiles: { [PAS_AGENT]: {} } });
    expect((await post(app)).statusCode).toBe(201);
    expect(renames).toEqual([{ sessionId: "pas-bootstrap-1", name: "PAS" }]);
    await app.close();
  });

  it("creates one session when two requests of the same caller overlap", async () => {
    let release: () => void = () => undefined;
    const createGate = new Promise<void>((resolve) => { release = resolve; });
    const { app, createBodies, callerIdCalls } = buildApp({ enabled: true, createGate });

    const first = post(app);
    const second = post(app);
    for (let attempt = 0; attempt < 200 && !(callerIdCalls() === 2 && createBodies.length === 1); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(callerIdCalls()).toBe(2);
    expect(createBodies).toHaveLength(1);
    release();

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.statusCode).toBe(201);
    expect(secondResponse.statusCode).toBe(201);
    expect(secondResponse.json()).toEqual(firstResponse.json());
    expect(createBodies).toHaveLength(1);

    // Once the run is over the new session is listed, so a later call creates nothing.
    const later = await post(app);
    expect(later.statusCode).toBe(200);
    expect(later.json()).toEqual({ created: false, session_id: "pas-bootstrap-1" });
    expect(createBodies).toHaveLength(1);
    await app.close();
  });

  it("passes the create path's own status and error through", async () => {
    const { app } = buildApp({ enabled: true, createStatus: 503 });
    const response = await post(app);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: { code: "CREATE_REFUSED", message: "refused" } });
    await app.close();
  });

  it("refuses a body key with 422", async () => {
    const { app, createBodies } = buildApp({ enabled: true });
    const response = await post(app, { display_name: "다른 이름" });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({
      error: { code: "INVALID_REQUEST", message: "display_name is not supported" },
    });
    expect(createBodies).toEqual([]);
    await app.close();
  });
});

describe("GET /api/persistent-sessions create_defaults.bootstrap_enabled", () => {
  it("is true when the switch is on", async () => {
    const { app } = buildApp({ enabled: true });
    const response = await app.inject({ method: "GET", url: "/api/persistent-sessions" });
    expect(response.json()).toMatchObject({ create_defaults: { bootstrap_enabled: true } });
    await app.close();
  });

  it("is false when the switch is off or absent", async () => {
    for (const enabled of [false, undefined]) {
      const { app } = buildApp(enabled === undefined ? {} : { enabled });
      const response = await app.inject({ method: "GET", url: "/api/persistent-sessions" });
      expect(response.json()).toMatchObject({ create_defaults: { bootstrap_enabled: false } });
      await app.close();
    }
  });
});
