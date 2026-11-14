/**
 * CompletionNotifier — 피위임 자식 완료 시 부모 세션 회송 (B-7).
 *
 * Legacy caller-completion notification contract의 codex 적응판.
 * TS는 `addIntervention` 내부에 auto-resume 책임이
 * 캡슐화되어 있어(L526 `onResume(task)`) Python처럼 별도 start_execution 분기를
 * 두지 않는다 — 표면이 더 좁고 깊은 모듈 (design-principles §1).
 *
 * 표면(단일 메서드):
 *   notify(task: Task): Promise<void>
 *
 * `send_message_to_session` 같은 일반 MCP relay와 *책임 분리* — 본 notifier는 finalized
 * Task 객체만 받는다. 임의 텍스트 송신 경로가 없어 일반 메시지 릴레이 오용 불가
 * (위임 프롬프트 🟡 #1, 분석 캐시 §2-5).
 *
 * 폴백 순서:
 *   1. local `taskManager.addIntervention(params, onResume)` — caller가 같은 노드.
 *   2. local throw 시 `POST {orch.baseUrl}/api/sessions/{caller}/intervene` — cross-node.
 *   3. 양쪽 모두 실패해도 *notify는 resolve* — child finalize에 throw 전파 금지
 *      (Python `task_manager.py:512-519` try/except 정합).
 */
import { createHash } from "node:crypto";

import type { Logger } from "pino";

import type { AgentRegistry } from "../agent_registry.js";
import { buildAgentCallerInfo, type AgentCallerInfo } from "../caller_info.js";
import type { SessionDeliveryHostClient } from "../control_plane/persistence_host_clients.js";
import type { SessionDB } from "../db/session_db.js";
import type { OrchProxyConfig } from "../mcp/runtime.js";

import { CompletionDeliveryCoordinator } from "./completion_delivery_coordinator.js";
import { decideCompletionSkip, type CompletionSkipReason } from "./completion_skip_policy.js";
import {
  buildBackgroundStoppedNotice,
  buildRetainedBackgroundNotice,
  buildStoppedBackgroundNotice,
  DEFAULT_CLAUDE_BACKGROUND_RETENTION_CAP_MS,
} from "./claude_background_retention_notice.js";
import { OrchInterveneClient } from "./orch_intervene_client.js";
import { relayCompletionCrossNode } from "./completion_cross_node_relay.js";
import {
  classifyCompletionDeliveryResult,
  type CompletionDeliveryVerdict,
} from "./completion_delivery_verdict.js";
import type {
  AddInterventionParams,
  StartExecutionCallback,
  TaskManager,
} from "./task_manager.js";
import type { Task } from "./task_models.js";

/**
 * 완료 통지 진입점. 임의 메시지 릴레이로 오용되지 않도록 표면을 좁게 유지한다.
 *
 * `notify`는 멈춤 단추·일반 완료 길이다 — 실패를 삼키고 resolve한다(기존 계약).
 * `notifyForDelete`는 삭제 길 전용이며 이번 종료 revision의 등록 결과를 실제로
 * 돌려준다. 등록이 확인되지 않으면 삭제 경로가 세션 행을 지우지 않는다.
 */
export interface CompletionNotifier {
  notify(task: Task, options?: CompletionNotifyOptions): Promise<CompletionSettleResult | void>;
  notifyForDelete?(task: Task): Promise<boolean>;
  /** 보유가 followup 없이 풀렸을 때 부른 세션에 알린다(R3/R5). */
  notifyBackgroundStopped?(task: Task, firstSentence: string): Promise<void>;
  recoverPending?(): Promise<void>;
}

/**
 * 완료 통지 한 번의 정산 결과다. 등록됨과 정책상 생략됨은 정산이 끝난 것이고,
 * 다시 해야 함이면 완료 정산 미결을 남겨 다음 훑기가 다시 본다.
 */
export type CompletionSettleResult =
  | { kind: "registered" }
  | { kind: "skipped"; reason: CompletionSkipReason }
  | { kind: "retry_required" };

export interface CompletionNotifyOptions {
  /** 다음 세대가 이어 가는 것이 확인됐다. 호출한 쪽이 예약의 실재를 보고 넘긴다. */
  nextGenerationContinues?: boolean;
}

type CompletionPreparation =
  | { skip: CompletionSkipReason }
  | { skip: null; prepared: PreparedCompletionDelivery };

interface PreparedCompletionDelivery {
  callerSessionId: string;
  callerInfo: AgentCallerInfo;
  text: string;
}

export class TaskCompletionNotifier implements CompletionNotifier {
  private readonly interveneClient?: OrchInterveneClient;
  private readonly durableCoordinator?: CompletionDeliveryCoordinator;

  constructor(
    private readonly nodeId: string,
    private readonly taskManager: TaskManager,
    private readonly agentRegistry: AgentRegistry,
    /**
     * `taskManager.addIntervention`의 두 번째 인자로 전달한다. terminal task가 재개될 때
     * `runtime/task_runtime_composition.ts`에서 연결한 콜백이 새 turn을 시작한다.
     */
    private readonly onResume: StartExecutionCallback,
    private readonly logger: Logger,
    private readonly orch?: OrchProxyConfig,
    fetchImpl?: typeof fetch,
    private readonly sessionLookup?: Pick<
      SessionDB,
      "getSession" | "getSessionOwnerNode"
    >,
    private readonly deliveryV2Enabled = false,
    deliveryRepository?: SessionDeliveryHostClient,
    private readonly backgroundRetentionCapMs = DEFAULT_CLAUDE_BACKGROUND_RETENTION_CAP_MS,
  ) {
    this.interveneClient = orch ? new OrchInterveneClient(orch, fetchImpl) : undefined;
    if (deliveryV2Enabled && deliveryRepository) {
      this.durableCoordinator = new CompletionDeliveryCoordinator({
        repository: deliveryRepository,
        dispatch: async (params) => {
          const verdict = await this._deliver(params);
          if (verdict.kind === "failed") {
            throw new Error("Completion delivery exhausted local and cross-node routes");
          }
          if (verdict.kind === "unknown") {
            if (!params.deliveryId || !params.deliveryAttemptToken) {
              throw new Error(
                "Unknown completion verdict requires a durable delivery id and attempt token",
              );
            }
            throw new Error(
              `Completion delivery verdict is unknown and must retry: ${verdict.reason}`,
            );
          }
        },
        logger,
      });
    }
  }

  async notify(
    task: Task,
    options: CompletionNotifyOptions = {},
  ): Promise<CompletionSettleResult | undefined> {
    const preparation = await this._prepareDelivery(
      task,
      undefined,
      options.nextGenerationContinues === true,
    );
    if (preparation.skip !== null) return { kind: "skipped", reason: preparation.skip };
    const registered = await this._deliverPrepared(task, preparation.prepared);
    // 완료 전달 v2가 꺼진 노드는 장부 확인이 없어 정산할 것이 없다. 지금 동작대로 결과를 돌려주지 않는다.
    if (!this.deliveryV2Enabled) return undefined;
    return registered ? { kind: "registered" } : { kind: "retry_required" };
  }

  /**
   * 보유가 followup 없이 풀렸을 때 부른 세션에 보내는 알림(R3). 까닭 문장 뒤에
   * 「이 세션은 더 보고하지 않습니다.」 꼬리를 붙인다. 부른 세션이 없으면 생략한다.
   */
  async notifyBackgroundStopped(task: Task, firstSentence: string): Promise<void> {
    const preparation = await this._prepareDelivery(
      task,
      buildBackgroundStoppedNotice(firstSentence),
    );
    if (preparation.skip !== null) return;
    await this._deliverPrepared(task, preparation.prepared, {
      relationSuffix: backgroundStopRelationSuffix(firstSentence),
    });
  }

  /**
   * 삭제 길 전용. 이번 종료 revision의 등록 결과를 실제로 돌려준다 — 실패를
   * 로그로 삼키지 않는다. 등록이 필요 없는 경우(notifyCompletion=false, caller
   * 없음, 자기 자신)는 true다. 일반 완료·멈춤 단추 길은 `notify`를 그대로 쓴다.
   */
  async notifyForDelete(task: Task): Promise<boolean> {
    const preparation = await this._prepareDelivery(task);
    if (preparation.skip !== null) return true;
    return await this._deliverPrepared(task, preparation.prepared, {
      requireRegistration: true,
    });
  }

  private async _prepareDelivery(
    task: Task,
    text?: string,
    nextGenerationContinues = false,
  ): Promise<CompletionPreparation> {
    const decision = await decideCompletionSkip(
      task,
      async () => await this._resolveCallerSessionId(task),
      nextGenerationContinues,
    );
    if (decision.skip !== null) {
      this.logger.info(
        {
          childId: task.agentSessionId,
          callerSessionId: task.callerSessionId,
          reason: decision.skip,
        },
        "Completion notification suppressed",
      );
      return { skip: decision.skip };
    }
    return {
      skip: null,
      prepared: {
        callerSessionId: decision.callerSessionId,
        callerInfo: this._buildCallerInfo(task),
        text: text ?? this._buildNotifyText(task),
      },
    };
  }

  private async _deliverPrepared(
    task: Task,
    prepared: PreparedCompletionDelivery,
    options: {
      requireRegistration?: boolean;
      relationSuffix?: string;
    } = {},
  ): Promise<boolean> {
    const { callerSessionId, callerInfo, text } = prepared;
    const childId = task.agentSessionId;
    if (this.deliveryV2Enabled) {
      if (!this.durableCoordinator || task.terminalEventId === undefined) {
        this.logger.error(
          { childId, callerSessionId, terminalEventId: task.terminalEventId },
          "Completion notification withheld: canonical terminal receipt is unavailable",
        );
        return false;
      }
      const input = {
        targetSessionId: callerSessionId,
        sourceSessionId: childId,
        terminalRevision: String(task.terminalEventId),
        text,
        callerInfo,
        ...task.rateLimitStopInfo,
        createdAt: task.completedAt ?? new Date(),
        ...(options.relationSuffix ? { relationSuffix: options.relationSuffix } : {}),
      };
      if (options.requireRegistration === true) {
        const registration = await this.durableCoordinator.enqueueForDelete(input);
        return registration.registered;
      }
      return await this.durableCoordinator.enqueue(input) === "registered";
    }
    const verdict = await this._deliver({
      agentSessionId: callerSessionId,
      text,
      user: "agent",
      callerInfo,
      ...task.rateLimitStopInfo,
    }, childId);
    return verdict.kind === "accepted" || verdict.kind === "settled";
  }

  async recoverPending(): Promise<void> {
    await this.durableCoordinator?.recoverPending();
  }

  private async _resolveCallerSessionId(task: Task): Promise<string | undefined> {
    const memoryCallerSessionId = task.callerSessionId;
    if (!this.sessionLookup) return memoryCallerSessionId;
    try {
      const child = await this.sessionLookup.getSession(task.agentSessionId);
      if (!child) {
        this.logger.warn(
          { childId: task.agentSessionId, callerSessionId: memoryCallerSessionId },
          "Completion child session lookup returned no row — retaining in-memory caller",
        );
        return memoryCallerSessionId;
      }
      if (child.card_id && child.caller_session_id) return child.caller_session_id;
      return memoryCallerSessionId;
    } catch (err) {
      this.logger.warn(
        { err, childId: task.agentSessionId, callerSessionId: memoryCallerSessionId },
        "Completion child session lookup failed — retaining in-memory caller",
      );
      return memoryCallerSessionId;
    }
  }

  private async _deliver(
    params: AddInterventionParams,
    sourceSessionId?: string,
  ): Promise<CompletionDeliveryVerdict> {
    const callerSessionId = params.agentSessionId;
    // Gate OFF is the pre-v2 local-first contract: no DB attempt scheduling point.
    if (!this.deliveryV2Enabled || await this._isLocalTarget(callerSessionId)) {
      try {
        const result = await this.taskManager.addIntervention(params, this.onResume);
        const verdict = classifyCompletionDeliveryResult(result);
        if (verdict.kind === "accepted") {
          this.logger.info(
            {
              ...(sourceSessionId ? { childId: sourceSessionId } : {}),
              callerSessionId,
              deliveryId: params.deliveryId,
              disposition: verdict.disposition,
            },
            "Completion notification accepted locally",
          );
        } else if (verdict.kind === "settled") {
          this.logger.info(
            {
              ...(sourceSessionId ? { childId: sourceSessionId } : {}),
              callerSessionId,
              deliveryId: params.deliveryId,
              disposition: verdict.disposition,
            },
            "Completion notification was already settled locally",
          );
        } else {
          this.logger.warn(
            {
              ...(sourceSessionId ? { childId: sourceSessionId } : {}),
              callerSessionId,
              deliveryId: params.deliveryId,
              reason: verdict.reason,
            },
            verdict.kind === "unknown"
              ? "Local completion notification delivery verdict is unknown"
              : "Local completion notification was not accepted",
          );
        }
        return verdict;
      } catch (err) {
        this.logger.warn(
          {
            err,
            ...(sourceSessionId ? { childId: sourceSessionId } : {}),
            callerSessionId,
            deliveryId: params.deliveryId,
          },
          "Local completion notification failed — trying cross-node relay",
        );
      }
    }

    if (!this.orch) {
      this.logger.warn(
        { ...(sourceSessionId ? { childId: sourceSessionId } : {}), callerSessionId },
        "orch fallback unavailable (single-node config) — notification dropped",
      );
      return { kind: "failed", reason: "orch_fallback_unavailable" };
    }
    return await relayCompletionCrossNode(this.interveneClient, this.logger, params, sourceSessionId);
  }

  private async _isLocalTarget(callerSessionId: string): Promise<boolean> {
    if (!this.sessionLookup) return true;
    try {
      const row = await this.sessionLookup.getSessionOwnerNode(callerSessionId);
      return !row?.node_id || row.node_id === this.nodeId;
    } catch (err) {
      if (this.deliveryV2Enabled) throw err;
      this.logger.warn(
        { err, callerSessionId },
        "Completion target ownership lookup failed — retaining local-first compatibility",
      );
      return true;
    }
  }

  /**
   * 자식 task의 profile_id 기준으로 v1 agent caller_info 조립.
   * Python `_notify_caller_completion`의 build_agent_caller_info 호출(L472-477)과 의미 동등.
   */
  private _buildCallerInfo(task: Task): AgentCallerInfo {
    const profile = task.agentProfileSnapshot ?? (task.profileId
      ? this.agentRegistry.get(task.profileId)
      : undefined);
    const sourceEmail = task.callerInfo?.email;
    return buildAgentCallerInfo({
      agentNode: this.nodeId,
      agentId: profile?.id ?? task.profileId ?? null,
      agentName: profile?.name ?? null,
      portraitPath: task.agentProfileHasDbPortrait
        ? `/api/agents/${profile?.id ?? task.profileId}/portrait`
        : profile?.portrait_path ?? null,
      email: typeof sourceEmail === "string" ? sourceEmail : undefined,
    });
  }

  /**
   * 완료(성공)/오류/중단 분기 + 빈 응답 fallback. Python L479-482를 TS lifecycle에 맞춰 확장.
   *
   * 분기 우선순위 (TS lifecycle 비대칭 차단 — code-reviewer P1):
   *   1. `interrupted` (cancelTask 경로) — Python은 finalize_task가 interrupted를 만들지 않지만
   *      TS는 `_finalize`가 모든 종료 status에 호출되므로 별도 분기 의무.
   *   2. `error` 또는 task.error 박힘 — engine throw / executionPromise 안전망.
   *   3. 그 외 (completed) — `lastAssistantText` 정본 + `(빈 응답)` fallback.
   *
   * `lastAssistantText`는 event_persistence.handleSideEffects가 최종 assistant_message로
   * 덮어쓰므로 finalize 시점에 마지막 turn 응답이 박혀 있음. 부재 시
   * `(빈 응답)` fallback으로 parent에 빈 메시지가 그대로 가는 것을 차단.
   */
  private _buildNotifyText(task: Task): string {
    const body = this._buildCompletionBody(task);
    const remaining = task.backgroundRuntimeAtTurnEnd ?? 0;
    if (remaining <= 0) return body;
    const line = task.runnerRetainedForDetachedWork === true
      ? buildRetainedBackgroundNotice(remaining, this.backgroundRetentionCapMs)
      : buildStoppedBackgroundNotice();
    return `${body}\n\n${line}`;
  }

  private _buildCompletionBody(task: Task): string {
    const sid = task.agentSessionId;
    if (task.terminationDetail === "user_stop") {
      const resultText = task.lastAssistantText?.trim() || "(빈 응답)";
      return `⏹️ 에이전트 세션을 사람이 멈춤 (ID: \`${sid}\`)\n\n${resultText}`;
    }
    if (task.status === "interrupted") {
      return `⚠️ 에이전트 세션 중단 (ID: \`${sid}\`)`;
    }
    if (task.status === "error" || task.error) {
      const errorText = task.error?.trim() ?? "";
      return `❌ 에이전트 세션 오류 (ID: \`${sid}\`)\n\n${errorText}`;
    }
    const resultText = task.lastAssistantText?.trim() || "(빈 응답)";
    return `✅ 에이전트 세션 완료 (ID: \`${sid}\`)\n\n${resultText}`;
  }
}

/**
 * 보유 해제 알림의 durable relation 꼬리표. 같은 세션·같은 종료 revision에서도
 * 완료 알림과 다른 deliveryId를 세우고, 같은 까닭의 알림은 한 번만 간다.
 */
function backgroundStopRelationSuffix(firstSentence: string): string {
  const reason = createHash("sha256").update(firstSentence).digest("hex").slice(0, 16);
  return `background_stopped:${reason}`;
}
