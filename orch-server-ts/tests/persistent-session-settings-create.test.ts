import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import type { ServiceCaller } from "../src/auth/service_caller.js";
import { ModelPresetAvailabilityError } from "../src/model/model_preset_availability.js";
import type { SessionCreateRouteResponse } from "../src/session/session_create_route_response.js";
import { PERSISTENT_INITIAL_INSTRUCTION } from "@soulstream/wire-schema/conversation-visibility";
import { PersistentSessionSettingsService } from "../src/session/persistent_session_settings_service.js";
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
  /** Presets the node advertises; undefined means every preset. */
  advertisedPresets?: readonly string[];
  /** Advertised presets that are not usable right now. */
  unavailablePresets?: readonly string[];
  defaultPasAgentId?: string | null;
  /** Nodes connected to the orchestrator; defaults to the configured node only. */
  connectedNodes?: readonly string[];
} = {}): {
  app: FastifyInstance;
  createBodies: Json[];
  sentSettings: Json[];
  service: PersistentSessionSettingsService;
  profileNodeCalls: string[];
} {
  const profileNodeCalls: string[] = [];
  const createBodies: Json[] = [];
  const sentSettings: Json[] = [];
  const rows = new Map<string, Json>();
  let created = 0;
  const service = new PersistentSessionSettingsService({ defaultExecutionNodeId:CONFIGURED_DEFAULT_NODE,
    connectedNodeIds: () => options.connectedNodes ?? [CONFIGURED_DEFAULT_NODE],
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
      bridge: { sendPendingCommand: async (payload: Json) => {
        sentSettings.push(payload);
        return { persistent: true, modelChange: "none" };
      } },
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
      resolveStaticForNode: (_nodeId: string, presetId: string) => {
        if (options.advertisedPresets !== undefined &&
          !options.advertisedPresets.includes(presetId)) {
          throw new ModelPresetAvailabilityError(
            "MODEL_PRESET_NOT_FOUND",
            `Model preset '${presetId}' is not advertised by node ${CONFIGURED_DEFAULT_NODE}`,
          );
        }
        return {
          id: presetId,
          backend: presetId.startsWith("claude-")
            ? "claude"
            : presetId.startsWith("codex-") ? "codex" : "antigravity",
          available: true,
          supported_efforts: ["high", "medium"],
          default_effort: "high",
        };
      },
      requireAvailable: (_nodeId: string, presetId: string) => {
        if (options.unavailablePresets?.includes(presetId)) {
          throw new ModelPresetAvailabilityError(
            "MODEL_PRESET_UNAVAILABLE",
            `Model preset '${presetId}' is not available right now`,
          );
        }
        return undefined as never;
      },
    },
    profiles: { listAgentProfiles: async (nodeId: string) => {
      profileNodeCalls.push(nodeId);
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
    ...(options.defaultPasAgentId === undefined
      ? {}
      : { defaultPasAgentId: options.defaultPasAgentId }),
  } as never);
  const app = Fastify();
  registerPersistentSessionSettingsRoutes(app, { service });
  return { app, createBodies, sentSettings, service, profileNodeCalls };
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

describe("PAS create defaults pick a connected node", () => {
  it("keeps the configured node while it is connected", async () => {
    const { app, service, profileNodeCalls } = buildApp({ connectedNodes: ["a-node", CONFIGURED_DEFAULT_NODE] });
    expect(await service.createDefaults()).toMatchObject({ node_id: CONFIGURED_DEFAULT_NODE });
    expect(profileNodeCalls).toEqual([CONFIGURED_DEFAULT_NODE]);
    await app.close();
  });

  it("falls back to the first connected node when the configured node is not connected", async () => {
    const { app, service, profileNodeCalls } = buildApp({ connectedNodes: ["a-node", "b-node"] });
    expect(await service.createDefaults()).toMatchObject({ node_id: "a-node" });
    expect(profileNodeCalls).toEqual(["a-node"]);
    await app.close();
  });

  it("returns an empty node and asks no node for profiles when none is connected", async () => {
    const { app, service, profileNodeCalls } = buildApp({ connectedNodes: [] });
    expect(await service.createDefaults()).toMatchObject({
      node_id: "", preferred_agent_id: null, unavailable_reason: null,
    });
    expect(profileNodeCalls).toEqual([]);
    await app.close();
  });
});

describe("PAS defaults follow the node's advertised models", () => {
  it("keeps the production result when Claude and Codex are both advertised", async () => {
    const { app, createBodies, sentSettings, service } = buildApp({
      advertisedPresets: ["claude-opus", "codex-6.2-sol"],
    });

    expect(await service.createDefaults()).toMatchObject({
      node_id: CONFIGURED_DEFAULT_NODE,
      preferred_agent_id: PAS_AGENT,
      settings: {
        default_model: { model_preset: "claude-opus", reasoning_effort: "high" },
        fallback_models: [{ model_preset: "codex-6.2-sol", reasoning_effort: "high" }],
      },
      unavailable_reason: null,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/persistent-sessions",
      payload: createBody(),
    });
    expect(response.statusCode).toBe(201);
    expect(createBodies[0]).toMatchObject({
      model_preset: "claude-opus",
      reasoningEffort: "high",
    });
    expect(sentSettings.at(-1)).toMatchObject({
      type: "set_persistent_session_settings",
      settings: {
        default_model: { model_preset: "claude-opus", reasoning_effort: "high" },
        fallback_models: [{ model_preset: "codex-6.2-sol", reasoning_effort: "high" }],
      },
    });
    await app.close();
  });

  it("promotes the Claude preset and passes an explicit empty fallback list on a Claude-only node", async () => {
    const { app, createBodies, sentSettings, service } = buildApp({
      advertisedPresets: ["claude-opus"],
    });

    expect(await service.createDefaults()).toMatchObject({
      settings: {
        default_model: { model_preset: "claude-opus", reasoning_effort: "high" },
        fallback_models: [],
      },
      unavailable_reason: null,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/persistent-sessions",
      payload: createBody({ settings: undefined }),
    });
    expect(response.statusCode).toBe(201);
    expect(createBodies[0]).toMatchObject({ model_preset: "claude-opus" });
    expect(sentSettings.at(-1)).toMatchObject({
      settings: {
        default_model: { model_preset: "claude-opus", reasoning_effort: "high" },
        fallback_models: [],
      },
    });
    await app.close();
  });

  it("uses the catalog fallback preset as the default on a Codex-only node", async () => {
    const { app, service, createBodies, sentSettings } = buildApp({ advertisedPresets: ["codex-6.2-sol"] });

    expect(await service.createDefaults()).toMatchObject({
      settings: {
        default_model: { model_preset: "codex-6.2-sol", reasoning_effort: "high" },
        fallback_models: [],
      },
      unavailable_reason: null,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/persistent-sessions",
      payload: createBody({ settings: undefined }),
    });
    expect(response.statusCode).toBe(201);
    expect(createBodies[0]).toMatchObject({ model_preset: "codex-6.2-sol", reasoningEffort: "high" });
    expect(sentSettings.at(-1)).toMatchObject({
      settings: {
        default_model: { model_preset: "codex-6.2-sol", reasoning_effort: "high" },
        fallback_models: [],
      },
    });
    await app.close();
  });

  it("keeps no default on a Gemini-only node and creates when Gemini is requested", async () => {
    const { app, createBodies, service } = buildApp({
      advertisedPresets: ["gemini-4-carbon"],
    });

    const defaults = await service.createDefaults();
    expect(defaults.settings.default_model).toEqual({ model_preset: null, reasoning_effort: null });
    expect(defaults.settings.fallback_models).toEqual([]);
    expect(defaults.unavailable_reason).toContain("claude-opus");

    const missing = await app.inject({
      method: "POST",
      url: "/api/persistent-sessions",
      payload: createBody({ settings: undefined }),
    });
    expect(missing.statusCode).toBe(422);

    const response = await app.inject({
      method: "POST",
      url: "/api/persistent-sessions",
      payload: createBody({
        settings: { default_model: { model_preset: "gemini-4-carbon", reasoning_effort: null } },
      }),
    });
    expect(response.statusCode).toBe(201);
    expect(createBodies[0]).toMatchObject({ model_preset: "gemini-4-carbon" });
    await app.close();
  });

  it("rejects an explicitly requested preset the node does not advertise", async () => {
    const { app } = buildApp({ advertisedPresets: ["claude-opus"] });

    const response = await app.inject({
      method: "POST",
      url: "/api/persistent-sessions",
      payload: createBody({
        settings: { default_model: { model_preset: "codex-6.2-sol", reasoning_effort: null } },
      }),
    });
    expect(response.statusCode).toBe(422);
    await app.close();
  });

  it("uses DEFAULT_PAS_AGENT_ID over the catalog agent", async () => {
    const { app, service } = buildApp({
      defaultPasAgentId: "claude-default",
      profiles: { "claude-default": { name: "Claude" } },
    });

    expect(await service.createDefaults()).toMatchObject({
      preferred_agent_id: "claude-default",
      unavailable_reason: null,
    });
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
