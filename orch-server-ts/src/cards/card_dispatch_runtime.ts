import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import { BoardYjsSqlResolver } from "../board-yjs/board_yjs_sql.js";
import type { SessionCommandRouter } from "../session/session_command_router.js";
import type { SessionCommandTransportBridge } from "../session/session_command_transport.js";
import { createRecurringSession } from "../session/recurring_session_creation.js";
import { intervenePayload } from "../session/session_action_command_payloads.js";
import type { ModelPresetAvailabilityService } from "../model/model_preset_availability.js";
import type { PushNotifier } from "../push/push_notifier.js";
import type { AdminAccessProvider } from "../admin/admin_access.js";
import type {
  InMemorySseReplayBroadcaster,
  SessionStreamEvent,
} from "../sse/replay_broadcaster.js";
import { CardDispatcher } from "./card_dispatcher.js";
import { CardDispatchRepository } from "./card_dispatch_repository.js";
import { createCardControlPlaneServiceProvider } from "./card_control_plane_runtime.js";
import {
  readCardDispatchSettings,
  updateCardDispatchSettings,
} from "./card_dispatch_settings.js";
import { CardOrchestrationRepository } from "./card_orchestration_repository.js";
import { CardOrchestrationCoordinator } from "./card_orchestration_coordinator.js";
import {
  readCardOrchestrationSettings,
  updateCardOrchestrationSettings,
} from "./card_orchestration_settings.js";
import { strictOrchestrationUsage } from "./orchestration_usage.js";
import type { UsageSummarySnapshot } from "../usage/usage_summary_service.js";
import type { OrchestrationCandidate } from "@soulstream/wire-schema/card-orchestration";
export async function createCardDispatchRuntime(options: {
  sqlResolver: LiveDbSqlResolver;
  router: SessionCommandRouter;
  bridge: SessionCommandTransportBridge;
  availability: ModelPresetAvailabilityService;
  notifier: PushNotifier;
  admin: AdminAccessProvider;
  broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>;
  warn: (message: string) => void;
  onFolderHeaderUpdated: () => Promise<void>;
  usageSnapshot: () => UsageSummarySnapshot;
  ensureSystemFolder: (input: {
    reservedId: string;
    parentFolderId: string | null;
    idempotencyKey: string;
  }) => Promise<void>;
  validateFolder: (id: string, ownerEmail: string) => Promise<boolean>;
}) {
  const resolver = new BoardYjsSqlResolver(options.sqlResolver);
  const resolveSql = () => resolver.resolveSql();
  let dispatcher: CardDispatcher;
  const serviceProvider = createCardControlPlaneServiceProvider({
    sqlResolver: options.sqlResolver,
    broadcaster: options.broadcaster,
    warn: options.warn,
    onFolderHeaderUpdated: options.onFolderHeaderUpdated,
    onMutation: (change) => dispatcher.acceptMutation(change),
  });
  const legacyOptions: import("./card_dispatcher.js").CardDispatcherOptions = {
    repository: new CardDispatchRepository(resolveSql),
    cards: serviceProvider,
    warn: options.warn,
    resolveTarget: (card, modelPreset) => {
      // Central agent identities have no default-node field; the configured card node wins, then the documented default.
      const nodeId = card.node_id ?? "eiaserinnys";
      const agentId = card.assignee_agent_id!;
      const preset = modelPreset ?? card.model_preset;
      try {
        const selection = options.router.selectNodeForCreate({
          nodeId,
          profileId: agentId,
          ...(preset ? { modelPresetId: preset } : {}),
        });
        const availability = selection.modelPresetId
          ? options.availability.resolveForNode(nodeId, selection.modelPresetId)
          : null;
        return {
          nodeId,
          agentId: selection.profileId,
          modelPreset: selection.modelPresetId ?? null,
          available: availability?.available ?? true,
          reason: availability?.reason_label ?? availability?.reason ?? null,
        };
      } catch (error) {
        return {
          nodeId,
          agentId,
          modelPreset: preset ?? null,
          available: false,
          reason: String(error),
        };
      }
    },
    launch: (input) =>
      createRecurringSession(
        {
          router: options.router,
          bridge: options.bridge,
          modelPresetAvailability: options.availability,
        },
        { ...input, callerInfo: { source: "system" } },
      ),
    sendMessage: async (sessionId, text, admission?:{runId:string;executionToken:string;cardId:string}) => {
      const parsed = intervenePayload(sessionId, {
        text,
        caller_info: { source: "system" },
      });
      if (!parsed.ok) throw new Error(parsed.message);
      const response = await options.bridge.sendPendingCommand(
        await options.router.routeExistingSessionPendingCommand({...parsed.value,...(admission?{orchestrationAdmission:admission}:{})}),
      );
      if (response.status === "error" || response.type === "error")
        throw new Error(String(response.message ?? response.code));
    },
    notify: (input) => options.notifier.notifyCard(input),
  };
  const orchestrationRepository = new CardOrchestrationRepository(resolveSql);
  const orchestrationSettings = async () =>
    readCardOrchestrationSettings(await resolveSql());
  const selectOrchestrator = async (
    candidates: readonly OrchestrationCandidate[],
  ) => {
    const reasons: string[] = [];
    for (const candidate of candidates) {
      try {
        options.router.selectNodeForCreate({
          nodeId: candidate.nodeId,
          profileId: candidate.agentId,
          modelPresetId: candidate.modelPreset,
        });
        const preset = options.availability.resolveStaticForNode(
          candidate.nodeId,
          candidate.modelPreset,
        );
        const usage = strictOrchestrationUsage(
          candidate.nodeId,
          preset,
          options.usageSnapshot(),
          new Date(),
          candidate.minimumRemainingPercent,
        );
        if (usage.available) {
          const response = await options.bridge.sendPendingCommand(
            options.router.createSession({
              type: "prepare_card_orchestration_decision",
              nodeId: candidate.nodeId,
              profile: candidate.agentId,
              model_preset: candidate.modelPreset,
            }),
          );
          if (
            response.status === "ready" &&
            typeof response.instructionsRevision === "string"
          )
            return {
              candidate,
              reason: null,
              instructionsRevision: response.instructionsRevision,
            };
          reasons.push(
            `${candidate.modelPreset}: ${String(response.reason ?? response.message ?? "decision_preparation_unavailable")}`,
          );
          continue;
        }
        reasons.push(`${candidate.modelPreset}: ${usage.reason}`);
      } catch (error) {
        reasons.push(`${candidate.modelPreset}: ${String(error)}`);
      }
    }
    return {
      candidate: null,
      reason: reasons.join("; ") || "no_orchestrator_candidates",
    };
  };
  const coordinator = new CardOrchestrationCoordinator({
    repository: orchestrationRepository,
    cards: serviceProvider,
    dispatch: legacyOptions.repository,
    settings: orchestrationSettings,
    resolveTarget: legacyOptions.resolveTarget,
    selectOrchestrator,
    ensureFolder: async (settings) => {
      const explicit = settings.policy.sessionFolderId;
      if (explicit) {
        if (!(await options.validateFolder(explicit, settings.updatedBy)))
          throw new Error("Explicit folder missing, archived or inaccessible");
        return explicit;
      }
      const reservation = await orchestrationRepository.reserveFolder(
        settings.policy.systemFolderParentId,
      );
      if (reservation.resolved_folder_id) {
        if (
          !(await options.validateFolder(
            reservation.resolved_folder_id,
            settings.updatedBy,
          ))
        )
          throw new Error(
            "Resolved system folder missing, archived or inaccessible",
          );
        return reservation.resolved_folder_id;
      }
      const id = reservation.provision_id!;
      const parentId = reservation.provision_request!.parentFolderId;
      if (
        parentId &&
        !(await options.validateFolder(parentId, settings.updatedBy))
      )
        throw new Error(
          "System folder parent missing, archived or inaccessible",
        );
      await options.ensureSystemFolder({
        reservedId: id,
        parentFolderId: parentId,
        idempotencyKey: `card-orchestration-folder:${id}`,
      });
      await orchestrationRepository.publishFolder(id);
      return id;
    },
    launchDecision: async ({
      run,
      folderId,
      prompt,
      outputSchema,
      instructionsRevision,
    }) => {
      const response = await options.bridge.sendPendingCommand(
        options.router.createSession({
          type: "create_card_orchestration_decision",
          agentSessionId: run.session_id,
          runId: run.id,
          leaseToken: run.execution_token,
          nodeId: run.target.nodeId,
          profile: run.target.agentId,
          model_preset: run.target.modelPreset,
          folderId,
          prompt,
          outputSchema,
          instructionsRevision: instructionsRevision ?? "server-compile",
        }),
      );
      if (response.status === "error" || response.type === "error")
        throw new Error(String(response.message ?? response.code));
      return response;
    },
    launchWorker: legacyOptions.launch,
    sendMessage: legacyOptions.sendMessage,
    warn: options.warn,
  });
  dispatcher = new CardDispatcher({
    ...legacyOptions,
    orchestration: {
      enabled: () => orchestrationRepository.enabled(),
      kick: () => coordinator.kick(),
      ownsSession: (id) => orchestrationRepository.ownsSession(id),
      decisionEnded: (id) => coordinator.decisionEnded(id),
    },
  });
  return {
    dispatcher,
    serviceProvider,
    authorizeWorker:(input:Parameters<CardOrchestrationRepository["authorizeWorker"]>[0])=>orchestrationRepository.authorizeWorker(input),
    authorizeDecision: (
      input: Parameters<CardOrchestrationRepository["authorize"]>[0],
    ) => orchestrationRepository.authorize(input),
    orchestrationSettingsRoutes: {
      get: orchestrationSettings,
      put: async (
        input: Parameters<typeof updateCardOrchestrationSettings>[1],
      ) => {
        const result = await updateCardOrchestrationSettings(
          await resolveSql(),
          input,
        );
        void dispatcher.dispatch();
        return result;
      },
      readStatus: () => orchestrationRepository.status(),
    },
    settingsRoutes: {
      ...options.admin,
      get: async () => readCardDispatchSettings(await resolveSql()),
      put: async (input: Parameters<typeof updateCardDispatchSettings>[1]) => {
        const result = await updateCardDispatchSettings(
          await resolveSql(),
          input,
        );
        void dispatcher.dispatch();
        return result;
      },
    },
  };
}
