import Fastify from "fastify";
import { vi } from "vitest";
import {
  InMemoryNodeRegistry, NodeCommandTransportHub, SessionCommandRouter,
  SessionCommandTransportBridge, NodeSnapshotService, InMemoryNodeStreamBroadcaster,
  registerNodeSnapshotRoutes, registerNodeAgentProfileRoutes, registerCogitoRoutes,
  registerSessionCommandRoutes, createLiveNodeAgentProfileRouteProviders,
  createLiveCogitoRouteProviders,
} from "../../../orch-server-ts/src/index.js";
import { registerMcpHostRoutes } from "../../../orch-server-ts/src/mcp/mcp_host_routes.js";
import { registerRecurringJobHostRoutes } from "../../../orch-server-ts/src/recurring-jobs/recurring_job_host_routes.js";
import { RecurringJobService } from "../../../orch-server-ts/src/recurring-jobs/service.js";
import type { RecurringJob, RecurringJobRun, RecurringJobRepository } from "../../../orch-server-ts/src/recurring-jobs/types.js";
import { registerCardOrchestrationRoutes } from "../../../orch-server-ts/src/cards/card_orchestration_routes.js";
import { CardOrchestrationSettingsError, type OrchestrationSettings } from "../../../orch-server-ts/src/cards/card_orchestration_settings.js";
import { createSessionCreateLifecycle } from "../../../orch-server-ts/src/session/session_create_lifecycle.js";
import { createSessionResourceAccessProvider } from "../../../orch-server-ts/src/session/session_resource_access.js";
import { createLiveDashboardAccessProvider } from "../../../orch-server-ts/src/runtime/live_dashboard_access_provider.js";
import { createLiveAuthenticatedUserResolvers } from "../../../orch-server-ts/src/runtime/live_authenticated_user_resolver.js";
import type { McpRuntime } from "../../src/mcp/runtime.js";

export const policy = { enabled: false, candidates: [{ agentId: "roselin", nodeId: "node-a", modelPreset: "sol", minimumRemainingPercent: 15 }],
  usageMaxAgeMs: 300000 as const, sessionFolderId: null, systemFolderParentId: null };
const now = "2026-10-02T00:00:00.000Z";
const callerEmail = (id: string) => id === "limited" ? "limited@example.com" : id === "no-email" ? undefined : "owner@example.com";

// Reuses the in-memory repository contract in recurring-job-routes.test.ts. No live DB or node is used.
function recurringFixture() {
  const jobs = new Map<string, RecurringJob>(), runs = new Map<string, RecurringJobRun>();
  let sequence = 0;
  const repository = {
    findJobForOwner: async (id: string, owner: string, archived = false) => {
      const job = jobs.get(id); return job?.ownerEmail === owner && (archived || job.archivedAt === null) ? job : null;
    },
    listJobsForOwner: async (owner: string, archived = false) => [...jobs.values()].filter(j => j.ownerEmail === owner && (archived || j.archivedAt === null)),
    findJobByCreateIdempotency: async (owner: string, key: string) => [...jobs.values()].find(j => j.ownerEmail === owner && j.createdIdempotencyKey === key) ?? null,
    createJob: async (job: RecurringJob) => { jobs.set(job.jobId, job); return job; },
    updateJob: async (job: RecurringJob, version: number) => {
      const current = jobs.get(job.jobId)!;
      if (current.version !== version) return { code: "VERSION_CONFLICT", job: current };
      const next = { ...job, version: version + 1 }; jobs.set(next.jobId, next); return next;
    },
    archiveJob: async (id: string, owner: string, version: number, actor: string, date: Date) => {
      const job = jobs.get(id); if (!job || job.ownerEmail !== owner) return null;
      if (job.version !== version) return { code: "VERSION_CONFLICT", job };
      const next = { ...job, archivedAt: date.toISOString(), updatedBy: actor, updatedAt: date.toISOString(), enabled: false, version: version + 1 };
      jobs.set(id, next); return next;
    },
    listRuns: async (id: string, limit: number) => [...runs.values()].filter(r => r.jobId === id).slice(0, limit),
    findRunByManualIdempotency: async () => null, findActiveRun: async () => null,
    createManualRun: async (run: RecurringJobRun) => { runs.set(run.runId, run); return { created: true, run }; },
    cancelAutomaticPendingRuns: async () => {},
  } as unknown as RecurringJobRepository;
  const validateTarget = vi.fn(async () => {});
  const service = new RecurringJobService({ repository, now: () => new Date(now), newId: () => `generated-${++sequence}`, validateTarget });
  const seed = () => {
    sequence = 0; jobs.clear(); runs.clear(); validateTarget.mockClear();
    const job: RecurringJob = { jobId: "job-1", ownerEmail: "owner@example.com", executionCaller: { source: "agent", email: "owner@example.com" },
      name: "정기 작업", prompt: "확인", timezone: "Asia/Seoul", scheduleKind: "recurring", runAt: null, scheduleExpressions: ["0 9 * * *"],
      nodeId: "node-a", agentId: "roselin", modelPreset: null, folderId: "allowed-folder", enabled: true, archivedAt: null,
      lateRunWindowSeconds: 1800, nextRunAt: "2026-10-03T00:00:00.000Z", version: 1, createdIdempotencyKey: "seed", createdBy: "caller", updatedBy: "caller", createdAt: now, updatedAt: now };
    jobs.set(job.jobId, job);
    for (let index = 0; index < 3; index++) runs.set(`seed-run-${index}`, { runId: `seed-run-${index}`, jobId: job.jobId } as RecurringJobRun);
  };
  return { service, seed, validateTarget };
}

export async function createClusterRoundtripFixture() {
  const registry = new InMemoryNodeRegistry({ nowMs: () => Date.parse(now), requestIdGenerator: ({ commandType }) => `fixed-${commandType}` });
  const registration = { type: "node_register" as const, node_id: "node-a", host: "127.0.0.1", port: 4105,
    agents: [{ id: "roselin", name: "로젤린", backend: "codex", default_preset: "sol" }], supported_backends: ["codex"],
    capabilities: { reflect_brief: true }, model_presets: [{ id: "sol", label: "Sol", backend: "codex", available: true }] };
  const connectionId = registry.registerNode(registration).node.connectionId;
  registry.receiveNodeMessage("node-a", { type: "runner_inventory", running_session_ids: [] });
  const sent: Record<string, unknown>[] = [];
  const transports = new NodeCommandTransportHub();
  const attach = () => transports.attach({ nodeId: "node-a", connectionId, transport: { send: (data) => {
    const command = JSON.parse(data); sent.push(command);
    registry.receiveNodeMessage({ nodeId: "node-a", connectionId }, command.type === "create_session"
      ? { type: "session_created", requestId: command.requestId, agentSessionId: command.agentSessionId }
      : command.type === "reflect_brief"
        ? { type: "reflect_brief", requestId: command.requestId, ok: true, checked_at: now, brief: { package: "test-worker" } }
        : { type: `${command.type}_result`, requestId: command.requestId, result: { ok: true } });
  } } });
  attach();
  const bridge = new SessionCommandTransportBridge({ registry, transports });
  // The legacy node fixture omits later availability metadata; preserve its wire payload.
  const nodeAgentProfiles = { ...createLiveNodeAgentProfileRouteProviders({ registry, bridge,
    nodeHttpClient: { requestNode: async () => { throw new Error("unused HTTP"); } }, agentProfileRepository: { list: async () => [], getPortrait: async () => null },
  }).nodeAgentProfileRoutes, modelPresetProvider: { listForNode: (id: string) => id === "node-a" ? registration.model_presets as unknown as import("../../../orch-server-ts/src/model/model_preset_availability.js").ModelPresetAvailability[] : undefined } };
  const cogito = createLiveCogitoRouteProviders({ registry, bridge, searchProvider: {} as never }).cogitoRoutes;
  const snapshotService = new NodeSnapshotService({ registry });
  const nodes = { snapshotService, broadcaster: new InMemoryNodeStreamBroadcaster({ snapshotService }) };
  const folders = [{ id: "allowed-folder", parentId: null }, { id: "forbidden-folder", parentId: null }, { id: "inherited-folder", parentId: null }];
  const jwt = { verifyToken: async () => null } as never;
  const accessProvider = createLiveDashboardAccessProvider({ jwt, configProvider: { getConfig: async () => ({ auth_bearer_token: "service-token", environment: "production", google_client_id: "" }) } as never,
    repository: { findUserByEmail: async email => ({ email, isAdmin: email === "owner@example.com", allowedFolderIds: ["allowed-folder"] }) } });
  const access = createSessionResourceAccessProvider({ accessProvider, repository: { getSessionAccessRecord: async () => null, listFoldersForAccess: async () => folders } });
  const sessions = { router: new SessionCommandRouter({ registry }), bridge,
    createSessionLifecycle: createSessionCreateLifecycle({ resolveCallerInfo: createLiveAuthenticatedUserResolvers({ jwt }).resolveCallerInfo,
      access, boardItems: { getCatalogSnapshot: async () => ({ folders, boardItems: [] }) } as never }) };
  const recurring = recurringFixture();
  const recurringJobs = { authBearerToken: "service-token", service: recurring.service };
  let settings: OrchestrationSettings;
  const cardOrchestration = { authBearerToken: "service-token", currentEmail: async () => "owner@example.com", resolveEmail: async () => "owner@example.com", isAdminEmail: async (email: string) => email === "owner@example.com",
    resolveCaller: async (id: string) => ({ ownerEmail: callerEmail(id) ?? "", purpose: id === "decision" ? "card_orchestration_decision" : null }),
    validateFolder: async () => true, get: async () => settings,
    put: async (input: { policy: unknown; expectedVersion: number; updatedBy: string }) => {
      if (input.expectedVersion !== settings.version) throw new CardOrchestrationSettingsError(409, "CARD_ORCHESTRATION_VERSION_CONFLICT", "Settings version changed");
      return settings = { ...settings, policy: input.policy as typeof policy, version: settings.version + 1, updatedBy: input.updatedBy };
    } };
  const readSession = async (id: string) => ({ folder_id: id === "limited" ? null : "inherited-folder" });
  const app = Fastify();
  registerNodeSnapshotRoutes(app, nodes); registerNodeAgentProfileRoutes(app, nodeAgentProfiles);
  registerCogitoRoutes(app, cogito); registerSessionCommandRoutes(app, sessions);
  registerRecurringJobHostRoutes(app, recurringJobs); registerCardOrchestrationRoutes(app, cardOrchestration);
  app.get<{ Params: { sessionId: string } }>("/api/persistence/sessions/:sessionId", async request => ({ session: await readSession(request.params.sessionId) }));
  const executionOptions = { board: undefined as never, authBearerToken: "service-token", recurringJobs, cardOrchestration,
    cluster: { nodes, nodeAgentProfiles, cogito, sessions, readSession, logger: app.log },
    cards: { provider: {} as never, resolveAccess: () => ({ restricted: false, allowedFolderIds: [] }) },
    folders: { authBearerToken: "service-token", serviceProvider: async () => { throw new Error("unused folders"); } } };

  registerMcpHostRoutes(app, executionOptions);
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const runtime = { nodeId: "worker-node", orch: { baseUrl, headers: { authorization: "Bearer service-token" } }, logger: app.log,
    taskManager: { getTask: (id: string) => ({ profileId: "roselin", callerInfo: { email: callerEmail(id) } }) },
    agentRegistry: { get: () => ({ id: "roselin", name: "로젤린", portrait_path: "portrait.png" }) },
    db: { getSession: readSession } } as unknown as McpRuntime;
  const seed = (missingTransport = false) => {
    recurring.seed(); settings = { key: "card_orchestration", policy, version: 1, updatedAt: now, updatedBy: "owner@example.com" };
    sent.length = 0; if (missingTransport) transports.detach({ nodeId: "node-a", connectionId }); else attach();
  };
  return { executionOptions, app, runtime, seed, sent, recurring, registry };
}
