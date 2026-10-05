import Fastify, { type FastifyInstance } from "fastify";
import type postgres from "postgres";
import { vi } from "vitest";

import type { SqlClient } from "../src/control_plane/control_plane_types.js";
import { SessionReadRepository } from "../src/control_plane/repositories/session_read_repository.js";
import { ModelPresetAvailabilityService } from "../src/model/model_preset_availability.js";
import { PersistentSessionSettingsService } from "../src/session/persistent_session_settings_service.js";
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

export const NODE_ID = "eiaserinnys";
export const PAS_AGENT = "seosoyoung-pas";

const NODE_PRESETS = [
  { id: "claude-opus", label: "Opus", backend: "claude", available: true, usage_provider: null,
    supported_efforts: ["low", "medium", "high"], default_effort: "high" },
  { id: "claude-sonnet", label: "Sonnet", backend: "claude", available: true, usage_provider: null,
    supported_efforts: ["low", "medium", "high"], default_effort: "medium" },
  { id: "codex-6.1-sol", label: "Sol", backend: "codex", available: true, usage_provider: null,
    supported_efforts: ["medium", "high"], default_effort: "high" },
];

type Json = Record<string, unknown>;

/** What the fake worker saw; the test resets it between cases. */
export type PersistentSettingsState = {
  metadataWrites: Array<{ type: string; replaceExistingType: string | null; waitForAck: boolean }>;
  failOnce: Set<string>;
  createdByRuntime: Array<Json & { ordinaryAtCreate: boolean }>;
  tasks: Map<string, unknown>;
};

export function createPersistentSettingsState(): PersistentSettingsState {
  return { metadataWrites: [], failOnce: new Set(), createdByRuntime: [], tasks: new Map() };
}

export async function buildPersistentSettingsApp(
  sql: ReturnType<typeof postgres>,
  state: PersistentSettingsState,
): Promise<FastifyInstance> {
  const { metadataWrites, failOnce, createdByRuntime, tasks } = state;
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

export async function waitForPostgres(client: ReturnType<typeof postgres>): Promise<void> {
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

