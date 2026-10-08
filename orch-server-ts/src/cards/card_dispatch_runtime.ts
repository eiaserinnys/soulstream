import { CardExecutionService, confirmedCommandFailure } from "./card_execution_service.js";
import { PendingNodeCommandRejectedError } from "../node/pending_commands.js";
import { buildCardPrompt } from "./card_prompt.js";
import { cardAttachmentPaths } from "./card_attachment_paths.js";
import { resolveCardSessionTarget } from "./card_session_target.js";
import { sendCardChangeOnce } from "./card_change_delivery.js";
import { SessionDeliveryRepository } from "../control_plane/repositories/session_delivery_repository.js";
import type { SessionDeliveryRow, SqlClient as DeliverySqlClient } from "../control_plane/control_plane_types.js";
import { sessionDeliveryInterventionPayload } from "../session/session_delivery_intervention_payload.js";
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
import { CardWorkDispatchService, type DispatchWorkActor } from "./card_work_dispatch_service.js";
import { canonicalWorkErrorDeliveryId, recordConfirmedErrorTx } from "./card_work_error_delivery.js";
import type { RepositorySql } from "./control_plane/card_types.js";
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
    deliveryExists: async id => !!await new SessionDeliveryRepository(await resolveSql() as unknown as DeliverySqlClient).get(id),
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
        { ...input, attachmentPaths:cardAttachmentPaths(input.attachments ?? [], input.nodeId), callerInfo: { source: "system" } },
      ),
    sendMessage: async (sessionId, text, admission?:{runId:string;executionToken:string;cardId:string;deliveryId?:string}, changeDelivery?:import("./card_change_notification.js").CardChangeDelivery, attachments?:readonly import("@soulstream/wire-schema/card-attachments").CardAttachment[]) => {
      const parsed = intervenePayload(sessionId, {
        text,
        ...(attachments?.length ? {attachment_paths:attachments.map(a=>a.path)} : {}),
        ...(admission?.deliveryId ? {delivery_id:admission.deliveryId,delivery_intent:"durable_next_turn",source:"card_orchestration",relation_key:admission.deliveryId,completion_id:admission.deliveryId} : {}),
        ...(changeDelivery ? {delivery_id:changeDelivery.deliveryId,delivery_intent:"durable_next_turn",source:"card_change",
          relation_key:changeDelivery.deliveryId,completion_id:changeDelivery.deliveryId} : {}),
        caller_info: changeDelivery ? { source:changeDelivery.actorKind === "user" ? "browser" : changeDelivery.actorKind === "agent" ? "agent" : "system",
          ...(changeDelivery.actorSessionId ? {session_id:changeDelivery.actorSessionId} : {}) } : { source: "system" },
      });
      if (!parsed.ok) throw new Error(parsed.message);
      const send = async (payload: typeof parsed.value) => {
        const routed = await options.router.routeExistingSessionPendingCommand({...payload,...(admission?{orchestrationAdmission:admission}:{})});
        cardAttachmentPaths(attachments ?? [], routed.node.nodeId);
        return options.bridge.sendPendingCommand(routed);
      };
      if (changeDelivery) {
        const repository = new SessionDeliveryRepository(await resolveSql() as unknown as DeliverySqlClient);
        return sendCardChangeOnce(repository, parsed.value, send);
      }
      const response = await send(parsed.value);
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
    resolveSessionTarget:async card=>{
      const resolved=await resolveCardSessionTarget(card,id=>legacyOptions.repository.ownerSession(id),identity=>{
        try {
          options.router.selectNodeForCreate({nodeId:identity.nodeId,profileId:identity.agentId,modelPresetId:identity.modelPreset});
          const preset=options.availability.resolveStaticForNode(identity.nodeId,identity.modelPreset);
          return strictOrchestrationUsage(identity.nodeId,preset,options.usageSnapshot(),new Date(),15);
        } catch(error) {return {available:false,reason:String(error)};}
      });
      return {nodeId:resolved.nodeId??"",agentId:resolved.agentId??"",modelPreset:resolved.modelPreset??null,available:resolved.available,reason:resolved.reason,
        ...(resolved.sessionId?{sessionId:resolved.sessionId,capacityClaimed:(await legacyOptions.repository.capacitySessionIds()).has(resolved.sessionId)}:{})};
    },
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
  const sendWorkDelivery = async (row: SessionDeliveryRow): Promise<void> => {
    const parsed = sessionDeliveryInterventionPayload(row);
    if (!parsed.ok) throw new Error(parsed.message);
    const sql = await resolveSql() as unknown as DeliverySqlClient;
    const repository = new SessionDeliveryRepository(sql);
    const send = async (payload: typeof parsed.value) => {
      const routed = await options.router.routeExistingSessionPendingCommand(payload);
      const response = await options.bridge.sendPendingCommand(routed);
      if (response.status === "error" || response.type === "error") {
        throw new PendingNodeCommandRejectedError({
          commandType: routed.command.commandType,
          requestId: routed.command.requestId,
          message: String(response.message ?? response.code ?? "Node rejected delivery"),
          response,
        });
      }
      return response;
    };
    try {
      await sendCardChangeOnce(repository, parsed.value, send, row);
    } catch (error) {
      const current = await repository.get(row.delivery_id);
      if (isAcceptedDelivery(current)) return;
      if (row.source === "card_change" && row.producer_kind === null && row.producer_id) {
        const confirmed = confirmedCommandFailure(error, row.delivery_id);
        if (confirmed) {
          const errorDelivery = await (await resolveSql()).begin(async transaction => {
            const operation = (await transaction<Array<{
              id: string;
              target_kind: string;
              target_id: string;
              operation_type: string;
              actor_kind: string;
              actor_session_id: string | null;
              idempotency_key: string | null;
            }>>`SELECT id,target_kind,target_id,operation_type,actor_kind,actor_session_id,idempotency_key
              FROM folder_operations WHERE id=${row.producer_id}`)[0];
            if (!operation || operation.target_kind !== "card" || operation.operation_type !== "add_card_comment"
              || operation.actor_kind !== "agent" || !operation.actor_session_id) return null;
            return await recordConfirmedErrorTx(transaction as unknown as RepositorySql, {
              operationId: operation.id,
              cardId: operation.target_id,
              workId: row.delivery_id,
              stage: "delivery",
              message: confirmed.message,
              failureId: confirmed.failureId,
            });
          });
          if (errorDelivery) {
            void sendWorkDelivery(errorDelivery).catch(sendError =>
              options.warn(`Confirmed card error delivery failed for ${errorDelivery.delivery_id}: ${errorMessage(sendError)}`));
          }
        }
      }
      throw error;
    }
  };
  const executionService=new CardExecutionService({sql:await resolveSql(),cards:await serviceProvider(),
    validate:async card=>{
      try{
      if(!card.node_id || !card.assignee_agent_id || !card.model_preset) throw Object.assign(new Error("폴더·노드·에이전트·모델을 선택한 뒤 실행하세요."),{statusCode:422});
      const selection=options.router.selectNodeForCreate({nodeId:card.node_id,profileId:card.assignee_agent_id,modelPresetId:card.model_preset});
      options.availability.requireAvailable(card.node_id,selection.modelPresetId!);
      return {nodeId:card.node_id,agentId:selection.profileId,modelPreset:selection.modelPresetId!};
      }catch(error){throw Object.assign(new Error(error instanceof Error?error.message:String(error)),{statusCode:422,code:"CARD_EXECUTION_SETTINGS_REQUIRED"});}
    },
    launch:async input=>{
      const detail=(await (await serviceProvider()).getCard(input.cardId))!;
      const folder=(await legacyOptions.repository.queued()).find(c=>c.id===input.cardId)?.folder_name
        ?? (await (await serviceProvider()).getFolder(detail.card.folder_id))!.folder.name;
      const answers=detail.questions.filter(q=>q.answer!==null).map(q=>`${String(q.text)} → ${String(q.answer)}`).join("\n");
      const prompt=buildCardPrompt({cardId:input.cardId,title:detail.card.title,folderName:folder,request:detail.card.request,
        brief:[detail.card.brief,answers].filter(Boolean).join("\n"),comments:detail.comments.filter(c=>c.author_kind==='user').map(c=>({id:String(c.id),createdAt:c.created_at as Date,body:String(c.body)})),
        running:(await legacyOptions.repository.running()).filter(c=>c.id!==input.cardId).map(c=>({title:c.title,folderName:c.folder_name}))});
      return createRecurringSession({router:options.router,bridge:options.bridge,modelPresetAvailability:options.availability},
        {sessionId:input.sessionId,prompt,cardId:input.cardId,folderId:input.target.folderId!,...input.target,
          attachmentPaths:cardAttachmentPaths(detail.card.attachments??[],input.target.nodeId),callerInfo:{source:input.callerSource}});
    },
    ensure:async input=>{
      const detail=(await (await serviceProvider()).getCard(input.cardId))!;
      const routed=await options.router.routeExistingSessionPendingCommand({type:"ensure_session_running",agentSessionId:input.sessionId,
        text:`카드 「${detail.card.title}」를 이어서 수행하세요.`,delivery_id:`card-execution:${input.requestId}`,
        attachment_paths:cardAttachmentPaths(detail.card.attachments??[],input.target.nodeId),caller_info:{source:input.callerSource}});
      const result=await options.bridge.sendPendingCommand(routed);
      if(result.status==='error' || result.type==='error')throw new PendingNodeCommandRejectedError({
        commandType:routed.command.commandType,requestId:routed.command.requestId,
        message:String(result.message??result.code??"Node rejected ensure_session_running"),response:result,
      });
      if(!result.execution || !['started','already_running'].includes(String(result.state)))throw new Error("실행 등록 결과를 확인하지 못했습니다.");
      return result as unknown as {state:"started"|"already_running";execution:import("./card_work_lifecycle.js").CardWorkExecution};
    },
    onConfirmedFailureTx: async (sql, request, failure) => {
      const executionKeyPrefix = "dispatch-work-execution:";
      if (!request.idempotency_key.startsWith(executionKeyPrefix)) return null;
      const operationId = request.idempotency_key.slice(executionKeyPrefix.length);
      if (!operationId) return null;
      const operation = (await sql<Array<{
        id: string;
        target_kind: string;
        target_id: string;
        operation_type: string;
        actor_kind: string;
        actor_session_id: string | null;
        idempotency_key: string | null;
      }>>`SELECT id,target_kind,target_id,operation_type,actor_kind,actor_session_id,idempotency_key
        FROM folder_operations WHERE id=${operationId}`)[0];
      const stage = request.mode === "create" ? "launch" : request.mode === "resume" ? "restart" : null;
      if (!stage || !operation || request.idempotency_key !== `${executionKeyPrefix}${operation.id}`
        || operation.target_kind !== "card" || operation.target_id !== request.card_id
        || operation.operation_type !== "create_card" || operation.actor_kind !== "agent"
        || !operation.actor_session_id) return null;
      return await recordConfirmedErrorTx(sql as unknown as RepositorySql, {
        operationId: operation.id,
        cardId: request.card_id,
        workId: request.id,
        stage,
        message: failure.message,
        failureId: failure.failureId,
      });
    },
    onConfirmedFailureCommitted: row => {
      void sendWorkDelivery(row).catch(error =>
        options.warn(`Confirmed card error delivery failed for ${row.delivery_id}: ${errorMessage(error)}`));
    },
  });
  const workDispatchServiceProvider = async (authorizeFolder: (folderId: string, actor: DispatchWorkActor) => Promise<void>) =>
    new CardWorkDispatchService({
      sql: await resolveSql(),
      cards: await serviceProvider(),
      execution: executionService,
      authorizeFolder,
      sendDelivery: sendWorkDelivery,
      emitCardUpdated: async (cardId, folderId) => {
        options.broadcaster.append({ type: "card_updated", cardId, folderId });
      },
      warn: options.warn,
    });
  const kickPendingWorkForNode = async (nodeId: string): Promise<void> => {
    const service = await workDispatchServiceProvider(async () => {
      throw new Error("Automated work recovery cannot authorize a new dispatch");
    });
    await service.kickPendingForNode(nodeId);
  };
  const kickCanonicalWorkError = async (sessionId: string, eventId: number): Promise<void> => {
    try {
      const deliveryId = canonicalWorkErrorDeliveryId(sessionId, eventId);
      const row = await new SessionDeliveryRepository(await resolveSql() as unknown as DeliverySqlClient).get(deliveryId);
      if (row) await sendWorkDelivery(row);
    } catch (error) {
      options.warn(`Canonical card error delivery failed for ${sessionId}/${eventId}: ${errorMessage(error)}`);
    }
  };
  return {
    dispatcher,
    serviceProvider,
    executionServiceProvider:async()=>executionService,
    workDispatchServiceProvider,
    sendWorkDelivery,
    kickPendingWorkForNode,
    kickCanonicalWorkError,
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

function isAcceptedDelivery(row: SessionDeliveryRow | null): boolean {
  return !!row && (row.state === "queued" || row.state === "delivered" || row.aggregate_state === "consumed");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
