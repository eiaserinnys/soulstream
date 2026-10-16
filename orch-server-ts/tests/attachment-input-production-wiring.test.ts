import type { FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { SERVICE_CALLER } from "../src/auth/service_caller.js";
import type { AttachmentReadRepository, AttachmentReadService } from "../src/attachments/attachment_read_service.js";
import { createLiveAttachmentInputAdmission } from "../src/attachments/live_attachment_input_admission.js";
import { createRecurringSession } from "../src/session/recurring_session_creation.js";
import {
  createLiveOrchestratorProviderBundle,
  createOrchestratorRuntimeServices,
  parseOrchServerConfig,
  type LiveProviderDependencies,
} from "../src/index.js";
import { UI_EVENT_COLLECTION_DISABLED } from "../src/ui-events/ui_event_settings.js";

const asset = {
  id: "attachment-a",
  storageKey: "private/attachment-a",
  storagePurpose: "attachment",
  storageEndpoint: "https://r2.example.test",
  storageBucket: "attachments",
  ownerKind: "user_email",
  ownerKey: "owner@example.test",
  registrationScope: null,
  sourceSessionId: null,
  originalName: "a.txt",
  mimeType: "text/plain",
  byteSize: 1,
  width: null,
  height: null,
  checksumSha256: null,
  uploadStatus: "committed" as const,
};

function input() {
  return {
    sessionId: "81d61f13-b99b-4c58-9830-55487618e4dc",
    prompt: "create",
    nodeId: "node-a",
    agentId: "agent-a",
    modelPreset: null,
    folderId: "folder-a",
    callerInfo: { source: "scheduler" },
  };
}

describe("live attachment input admission wiring", () => {
  it("checks owner, then target session only after an owner 403", async () => {
    const repository: AttachmentReadRepository = {
      getAsset: vi.fn(async () => asset),
      getLegacyAlias: vi.fn(async () => ({ assetId: asset.id, availability: "resolved" as const })),
      getSqlScopeEvidence: vi.fn(async () => null),
      listLegacyCandidateScopes: vi.fn(async () => []),
    };
    const denied = Object.assign(new Error("owner denied"), { statusCode: 403 });
    const metadata = vi.fn<AttachmentReadService["metadata"]>(async (_actor, _id, context) => {
      if (context.type === "owner") throw denied;
      return { descriptor: {} as never, upload_status: "committed" as const };
    });
    const admission = createLiveAttachmentInputAdmission({
      repository,
      resolveEmail: vi.fn(async () => "owner@example.test"),
      readService: { metadata } as unknown as AttachmentReadService,
      findSessionNode: vi.fn(async () => "node-db"),
    });

    await expect(admission.forRequest({ headers: {} } as FastifyRequest, {
      sessionId: "session-a",
      attachmentPaths: ["/tmp/a.txt"],
    })).resolves.toEqual({
      attachment_ids: [asset.id],
      attachment_paths: ["/tmp/a.txt"],
      attachment_bindings: [{ attachment_id: asset.id, node_id: "node-db", path: "/tmp/a.txt" }],
    });
    expect(metadata.mock.calls.map((call) => call[2])).toEqual([
      { type: "owner" },
      { type: "session", id: "session-a" },
    ]);
  });

  it("does not promote ServiceCaller or body caller_info into a user actor", async () => {
    const repository: AttachmentReadRepository = {
      getAsset: vi.fn(async () => asset),
      getLegacyAlias: vi.fn(async () => null),
      getSqlScopeEvidence: vi.fn(async () => null),
      listLegacyCandidateScopes: vi.fn(async () => []),
    };
    const resolveEmail = vi.fn(async () => null);
    const metadata = vi.fn();
    const admission = createLiveAttachmentInputAdmission({
      repository,
      resolveEmail,
      readService: { metadata } as unknown as AttachmentReadService,
      findSessionNode: vi.fn(async () => "node-db"),
    });

    await expect(admission.forRequest(SERVICE_CALLER, {
      sessionId: "session-a",
      attachmentIds: [asset.id],
    })).rejects.toMatchObject({ code: "ATTACHMENT_UNAUTHENTICATED", statusCode: 401 });
    await expect(admission.forRequest({
      headers: {},
      body: { caller_info: { email: "owner@example.test" } },
    } as unknown as FastifyRequest, {
      sessionId: "session-a",
      attachmentIds: [asset.id],
    })).rejects.toMatchObject({ code: "ATTACHMENT_UNAUTHENTICATED", statusCode: 401 });
    expect(resolveEmail).toHaveBeenCalledTimes(1);
    expect(metadata).not.toHaveBeenCalled();
  });

  it("admits recurring IDs before command creation and rejects IDs without admission", async () => {
    const routed = { node: { nodeId: "node-a" }, command: { requestId: "r1" }, modelPresetId: null };
    const createSession = vi.fn((_payload: unknown) => routed);
    const admitted = {
      attachment_ids: [asset.id],
      attachment_paths: ["/tmp/a.txt"],
      attachment_bindings: [{ attachment_id: asset.id, node_id: "node-a", path: "/tmp/a.txt" }],
    };
    const admitAttachments = vi.fn(async () => admitted);
    await createRecurringSession({
      router: { createSession, waitForCreatedSession: async () => true } as never,
      bridge: { sendPendingCommand: async () => ({ type: "session_created", agentSessionId: input().sessionId }) } as never,
      admitAttachments,
    }, { ...input(), attachmentIds: [asset.id] });
    expect(admitAttachments).toHaveBeenCalledWith(expect.objectContaining({ attachmentIds: [asset.id] }));
    expect(createSession.mock.calls[0]![0]).toMatchObject({
      attachment_ids: admitted.attachment_ids,
      attachment_paths: admitted.attachment_paths,
      attachment_bindings: admitted.attachment_bindings,
    });

    const trustedCreate = vi.fn((_payload: unknown) => routed);
    await createRecurringSession({
      router: { createSession: trustedCreate, waitForCreatedSession: async () => true } as never,
      bridge: { sendPendingCommand: async () => ({ type: "session_created", agentSessionId: input().sessionId }) } as never,
    }, {
      ...input(),
      attachmentIds: [asset.id],
      attachmentBindings: admitted.attachment_bindings,
    });
    expect(trustedCreate.mock.calls[0]![0]).toMatchObject({
      attachment_ids: [asset.id],
      attachment_bindings: admitted.attachment_bindings,
    });

    await expect(createRecurringSession({
      router: { createSession: vi.fn() } as never,
      bridge: {} as never,
    }, { ...input(), attachmentIds: [asset.id] })).rejects.toMatchObject({
      code: "ATTACHMENT_INPUT_UNAVAILABLE",
      statusCode: 503,
    });
  });

  it("wires one request admission through live action, create, and execute providers", async () => {
    const repository: AttachmentReadRepository = {
      getAsset: vi.fn(async (id) => id === asset.id ? asset : null),
      getLegacyAlias: vi.fn(async () => null),
      getSqlScopeEvidence: vi.fn(async () => null),
      listLegacyCandidateScopes: vi.fn(async () => []),
    };
    const config = parseOrchServerConfig({
      environment: "test",
      databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
      authBearerToken: "test-token",
    });
    const runtimeServices = createOrchestratorRuntimeServices({
      config,
      loadSessionSnapshot: async () => ({ sessions: [] }) as never,
      sessionHistoryProvider: {} as never,
      enableSessionActionCommandRoutes: true,
      enableSessionBackgroundScheduleRoutes: true,
      sseReplayOnlyForTests: true,
    });
    const dependencies = createFactoryDependencies(repository);
    const findSessionNode = vi.fn(async () => "node-a");
    const bundle = createLiveOrchestratorProviderBundle({
      dependencies,
      runtimeServices,
      usageSummaryRoutes: { service: {
        getSummary: () => ({ generatedAt: "2026-07-20T10:00:00.000Z", collectedAt: null, nodes: [] }),
        getLimitRejection: () => null,
      } },
      uiEventRepository: {
        readConfig: async () => UI_EVENT_COLLECTION_DISABLED,
        insertBatch: async () => [], query: async () => [], listInstalls: async () => [], pruneExpired: async () => 0,
      },
      resolveReadStorage: async () => null,
      readPageAttachmentEvidence: async () => null,
      findSessionNode,
    });
    runtimeServices.registry.registerNode({
      type: "node_register",
      node_id: "node-a",
      host: "127.0.0.1",
      port: 4105,
      agents: [{ id: "agent-a", backend: "claude" }],
      capabilities: { max_concurrent: 8, runner_inventory_v1: true },
      supported_backends: ["claude"],
    });
    runtimeServices.registry.receiveNodeMessage("node-a", { type: "runner_inventory", running_session_ids: [] });
    const sendPendingCommand = vi.fn(async (routed: {
      node: { nodeId: string };
      command: { requestId: string; message: Record<string, unknown> };
    }) => {
      const response = {
        type: "session_created",
        requestId: routed.command.requestId,
        agentSessionId: routed.command.message.agentSessionId,
      };
      runtimeServices.registry.receiveNodeMessage("node-a", response);
      return response;
    });
    (runtimeServices.sessionBridge as unknown as { sendPendingCommand: typeof sendPendingCommand })
      .sendPendingCommand = sendPendingCommand;
    const token = await bundle.authRoutes.jwt.issueToken({ email: "owner@example.test", name: "Owner" });
    const request = { headers: { cookie: `soul_dashboard_auth=${token}` } } as FastifyRequest;
    const noAttachments = await bundle.executeProxyRoutes.provider.executeNew({
      prompt: "plain",
      profile: "agent-a",
      caller_info: { source: "browser", email: "forged@example.test" },
    }, request);
    const pathOnly = await bundle.executeProxyRoutes.provider.executeNew({
      prompt: "legacy",
      profile: "agent-a",
      caller_info: { source: "browser" },
      attachment_paths: ["/tmp/plain.txt"],
    }, request);
    const withId = await bundle.executeProxyRoutes.provider.executeNew({
      prompt: "attached",
      profile: "agent-a",
      caller_info: { source: "browser", email: "forged@example.test" },
      attachment_ids: [asset.id],
    }, request);
    for (const result of [noAttachments, pathOnly, withId]) {
      if ("body" in result && typeof result.body !== "string") result.body.destroy();
    }

    expect(sendPendingCommand.mock.calls.map((call) => call[0].command.message)).toEqual([
      expect.not.objectContaining({ attachment_ids: expect.anything(), attachment_paths: expect.anything() }),
      expect.objectContaining({ attachment_paths: ["/tmp/plain.txt"] }),
      expect.objectContaining({ attachment_ids: [asset.id] }),
    ]);
    expect(bundle.runtime.sessionActionCommandRoutes.admitAttachmentInput)
      .toBe(bundle.runtime.sessionCommandRoutes.admitAttachmentInput);
    await bundle.runtime.sessionActionCommandRoutes.admitAttachmentInput!(request, {
      sessionId: "existing-session",
      attachmentIds: [asset.id],
    });
    expect(findSessionNode).toHaveBeenCalledWith("existing-session");
  });
});

function createFactoryDependencies(repository: AttachmentReadRepository): LiveProviderDependencies {
  const noOp = async () => undefined;
  const catalog: Record<string, unknown> = {
    attachmentReadRepository: repository,
    attachmentCommitRepository: {},
    adminUsersRepository: { findUserByEmail: async () => null },
    folderRouteProvider: {
      listFolders: async () => [], listSessionAssignments: async () => ({}),
      listSessionAssignmentsByIds: async () => ({}), listBoardItemIdsForSessionDeletion: async () => [],
    },
    folderCountsProvider: {},
    boardAssetRouteProvider: { commitFileAsset: async () => ({}) },
    boardItemRouteProvider: {},
    markdownDocumentRouteProvider: {},
    sessionCatalogProvider: {
      renameSession: noOp, moveSessionsToFolder: async () => ({ count: 0 }),
      updateSessionCatalog: noOp, deleteSession: noOp, getSessionCards: async () => [], updateReadPosition: noOp,
    },
    sessionHistoryProvider: {},
    cogitoSearchProvider: { search: async () => ({ results: [], navigation_results: [] }) },
    sessionResourceAccessRepository: { getSessionAccessRecord: async () => null, listFoldersForAccess: async () => [] },
    sessionReviewRepository: { acknowledgeSessionReview: noOp },
    userPreferencesRepository: {},
    agentProfileRepository: { snapshot: () => [] },
    contextBundleRepository: {},
    loadSessionSnapshot: async () => ({ sessions: [] }),
    listSessionSnapshots: async () => ({ sessions: [], sessionList: [], total: 0, cursor: null, nextCursor: null, hasMore: false }),
    findSessionOwnerNodeId: async () => null,
    findRescuableSessionOwnerNodeId: async () => null,
  };
  return {
    dbCatalogRepository: catalog,
    nodeHttpClient: { requestNode: async () => ({ statusCode: 200 }) },
    pushRepository: {},
    configProvider: {
      getConfig: async () => ({ jwt_secret: "jwt-secret", environment: "test" }),
      requireConfig: async (key: string) => key === "jwt_secret" ? "jwt-secret" : "test",
    },
    systemPortraitAssets: { readSystemPortraitAsset: async () => undefined },
  } as unknown as LiveProviderDependencies;
}
