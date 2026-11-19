import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import type { ServiceCaller } from "../src/auth/service_caller.js";
import type { SessionCreateRouteResponse } from "../src/session/session_create_route_response.js";
import {
  PERSISTENT_INITIAL_INSTRUCTION,
  PersistentSessionSettingsService,
} from "../src/session/persistent_session_settings_service.js";
import { registerPersistentSessionSettingsRoutes } from "../src/session/persistent_session_settings_routes.js";
import { repositoryModelCatalog } from "./helpers/model_catalog.js";

// POST /api/persistent-sessions keeps the caller's provenance: a body caller_info reaches the
// ordinary create path unchanged, and its absence leaves the create body exactly as before.

const catalog = repositoryModelCatalog();
const PAS_AGENT = "seosoyoung-pas";
// 조립 지점이 주입하는 기본 실행 노드. 운영 기본값과 다른 값을 써서 주입이 동작함을 본다.
const CONFIGURED_DEFAULT_NODE = "worker-node";
const LEGACY_DEFAULT_NODE = "eiaserinnys";

type Json = Record<string, unknown>;

function buildApp(options: {
  agentId?: string | null;
  profiles?: Record<string, { name: string }> | null;
} = {}): { app: FastifyInstance; createBodies: Json[]; service: PersistentSessionSettingsService } {
  const createBodies: Json[] = [];
  const rows = new Map<string, Json>();
  let created = 0;
  const service = new PersistentSessionSettingsService({ defaultExecutionNodeId:CONFIGURED_DEFAULT_NODE,
    reads: async () => ({
      getSession: async (sessionId: string) => rows.get(sessionId) ?? null,
      listPersistentSessions: async () => [],
    }),
    access: {
      resolveAccess: async () => ({ restricted: false, allowedFolderIds: [] }) as never,
      requireSessionAccess: async () => undefined,
      requireFolderAccess: async () => undefined,
    },
    catalog: { renameSession: async () => undefined },
    commands: {
      router: { routeExistingSessionPendingCommand: async (payload: Json) => payload as never },
      bridge: { sendPendingCommand: async () => ({ persistent: true, modelChange: "none" }) },
      timeoutMs: 1_000,
    },
    createSession: async (
      _request: FastifyRequest | ServiceCaller,
      body: Record<string, unknown>,
    ): Promise<SessionCreateRouteResponse> => {
      createBodies.push(body);
      const sessionId = `pas-create-${++created}`;
      rows.set(sessionId, {
        session_id: sessionId,
        display_name: null,
        node_id: ctxNodeId(body),
        folder_id: typeof body.folderId === "string" ? body.folderId : null,
        agent_id: String(body.profile),
        model_preset: String(body.model_preset),
        model: `${String(body.model_preset)}-model`,
        reasoning_effort: typeof body.reasoningEffort === "string" ? body.reasoningEffort : "auto",
        metadata: [],
      });
      return { status: 201, body: { agentSessionId: sessionId } };
    },
    presets: {
      resolveStaticForNode: (_nodeId: string, presetId: string) => ({
        id: presetId,
        backend: presetId.startsWith("claude-") ? "claude" : "codex",
        available: true,
        supported_efforts: ["high", "medium"],
        default_effort: "high",
      }),
      requireAvailable: () => undefined as never,
    },
    profiles: { listAgentProfiles: async (nodeId: string) => {
      expect(nodeId).toBe(CONFIGURED_DEFAULT_NODE);
      return options.profiles === null
        ? undefined : options.profiles ?? { [PAS_AGENT]: { name: "서소영 (PAS)" } };
    } },
    modelCatalog: options.agentId === undefined ? catalog : {
      snapshot: () => {
        const snapshot = catalog.snapshot();
        const { agent_id: _agentId, ...defaults } = snapshot.persistent_defaults;
        return { ...snapshot, persistent_defaults: options.agentId === null
          ? defaults : { ...defaults, agent_id: options.agentId } };
      },
    },
  } as never);
  const app = Fastify();
  registerPersistentSessionSettingsRoutes(app, { service });
  return { app, createBodies, service };
}

function ctxNodeId(body: Json): string {
  return typeof body.nodeId === "string" ? body.nodeId : LEGACY_DEFAULT_NODE;
}

function createBody(extra: Json = {}): Json {
  return {
    display_name: "새 PAS",
    agent_id: PAS_AGENT,
    initial_instruction: "",
    settings: { default_model: { model_preset: "claude-opus", reasoning_effort: null } },
    ...extra,
  };
}

describe("PAS create defaults from the catalog", () => {
  it("uses the configured agent when its profile is on the default node", async () => {
    const { app, service } = buildApp();
    expect(await service.createDefaults()).toMatchObject({
      node_id: CONFIGURED_DEFAULT_NODE, preferred_agent_id: PAS_AGENT, unavailable_reason: null,
    });
    await app.close();
  });

  it("uses a different agent when the catalog and node profile change", async () => {
    const { app, service } = buildApp({ agentId: "another-pas", profiles: { "another-pas": { name: "다른 PAS" } } });
    expect(await service.createDefaults()).toMatchObject({ preferred_agent_id: "another-pas", unavailable_reason: null });
    await app.close();
  });

  it("reports a configured agent missing from the default node", async () => {
    const { app, service } = buildApp({ agentId: "another-pas", profiles: {} });
    expect(await service.createDefaults()).toMatchObject({
      preferred_agent_id: null,
      unavailable_reason: `프로필 another-pas이(가) 노드 ${CONFIGURED_DEFAULT_NODE}에 없습니다.`,
    });
    await app.close();
  });

  it("keeps the connection reason when the configured agent's node is unavailable", async () => {
    const { app, service } = buildApp({ profiles: null });
    expect(await service.createDefaults()).toMatchObject({
      preferred_agent_id: null,
      unavailable_reason: `노드 ${CONFIGURED_DEFAULT_NODE}에 연결할 수 없어 프로필을 확인하지 못했습니다.`,
    });
    await app.close();
  });

  it("omits the preferred agent and its reason when the catalog does not set one", async () => {
    const { app, service } = buildApp({ agentId: null, profiles: null });
    expect(await service.createDefaults()).toMatchObject({ preferred_agent_id: null, unavailable_reason: null });
    await app.close();
  });
});

describe("POST /api/persistent-sessions caller provenance", () => {
  it("hands the body caller_info to the ordinary create path", async () => {
    const { app, createBodies } = buildApp();
    const callerInfo = {
      source: "channel_observer",
      agent_node: "eiaserinnys",
      display_name: "채널 관찰자",
      user_id: null,
      avatar_url: "/api/system/portraits/channel_observer",
    };

    const response = await app.inject({
      method: "POST",
      url: "/api/persistent-sessions",
      payload: createBody({ caller_info: callerInfo }),
    });

    expect(response.statusCode).toBe(201);
    expect(createBodies).toHaveLength(1);
    expect(createBodies[0]!.caller_info).toEqual(callerInfo);
    await app.close();
  });

  it("rejects a caller_info that is not a JSON object", async () => {
    const { app, createBodies } = buildApp();

    for (const callerInfo of [[], null, "channel_observer", 7]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/persistent-sessions",
        payload: createBody({ caller_info: callerInfo }),
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().error).toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(createBodies).toHaveLength(0);
    await app.close();
  });

  it("keeps the create body unchanged when caller_info is absent", async () => {
    const { app, createBodies } = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/persistent-sessions",
      payload: createBody(),
    });

    expect(response.statusCode).toBe(201);
    expect(createBodies).toEqual([{
      profile: PAS_AGENT,
      nodeId: CONFIGURED_DEFAULT_NODE,
      model_preset: "claude-opus",
      reasoningEffort: "high",
      initial_instruction: PERSISTENT_INITIAL_INSTRUCTION,
    }]);
    await app.close();
  });
});
