/**
 * CompletionNotifier — 피위임 자식 완료 시 부모 세션 회송 (B-7).
 *
 * Python `soul-server/src/soul_server/service/task_manager.py::_notify_caller_completion`
 * (L446-519) 정본의 codex 적응판. TS는 `addIntervention` 내부에 auto-resume 책임이
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
import type { Logger } from "pino";

import type { AgentRegistry } from "../agent_registry.js";
import { buildAgentCallerInfo, type AgentCallerInfo } from "../caller_info.js";
import type { OrchProxyConfig } from "../mcp/runtime.js";

import type {
  AddInterventionParams,
  StartExecutionCallback,
  TaskManager,
} from "./task_manager.js";
import type { Task } from "./task_models.js";

/**
 * 본 notifier의 *유일한* 진입점. 다른 public 메서드를 추가하지 않는다 —
 * 임의 메시지 릴레이로 오용 차단 (위임 프롬프트 🟡 #1).
 */
export interface CompletionNotifier {
  notify(task: Task): Promise<void>;
}

export class TaskCompletionNotifier implements CompletionNotifier {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly nodeId: string,
    private readonly taskManager: TaskManager,
    private readonly agentRegistry: AgentRegistry,
    /**
     * `taskManager.addIntervention`의 두 번째 인자로 forward. parent가 terminal 상태면
     * `_addInterventionAutoResume`이 본 콜백을 호출하여 새 turn 시작. running이면 호출되지 않음.
     * main.ts wiring에서 `taskExecutor.startExecution(task, agent)`을 호출하도록 구성.
     */
    private readonly onResume: StartExecutionCallback,
    private readonly logger: Logger,
    private readonly orch?: OrchProxyConfig,
    fetchImpl?: typeof fetch,
  ) {
    // 테스트가 fetch mock을 주입 — 운영 시 globalThis.fetch (Node 18+ 내장).
    this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
  }

  async notify(task: Task): Promise<void> {
    const callerSessionId = task.callerSessionId;
    if (!callerSessionId) {
      // 위임받지 않은 task — 회송 대상 없음.
      return;
    }

    const callerInfo = this._buildCallerInfo(task);
    const text = this._buildNotifyText(task);
    const childId = task.agentSessionId;

    // 1. local — 같은 노드에 caller가 있으면 즉시 처리.
    try {
      await this.taskManager.addIntervention(
        {
          agentSessionId: callerSessionId,
          text,
          user: "agent",
          callerInfo,
        },
        this.onResume,
      );
      this.logger.info(
        { childId, callerSessionId },
        "Completion notification delivered locally",
      );
      return;
    } catch (err) {
      this.logger.warn(
        { err, childId, callerSessionId },
        "Local completion notification failed — trying cross-node relay",
      );
    }

    // 2. orch fallback — caller가 다른 노드 또는 evicted 상태에서 hydrate 실패.
    if (!this.orch) {
      this.logger.warn(
        { childId, callerSessionId },
        "orch fallback unavailable (single-node config) — notification dropped",
      );
      return;
    }
    await this._relayCrossNode(callerSessionId, text, callerInfo, childId);
  }

  /**
   * 자식 task의 profile_id 기준으로 v1 agent caller_info 조립.
   * Python `_notify_caller_completion`의 build_agent_caller_info 호출(L472-477)과 의미 동등.
   */
  private _buildCallerInfo(task: Task): AgentCallerInfo {
    const profile = task.profileId
      ? this.agentRegistry.get(task.profileId)
      : undefined;
    return buildAgentCallerInfo({
      agentNode: this.nodeId,
      agentId: task.profileId ?? null,
      agentName: profile?.name ?? null,
      portraitPath: profile?.portrait_path ?? null,
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
   * `lastAssistantText`는 event_persistence.handleSideEffects(L122-129)가 매 text_delta마다
   * 누적 block.text 전체로 덮어쓰므로 finalize 시점에 마지막 turn 응답이 박혀 있음. 부재 시
   * `(빈 응답)` fallback으로 parent에 빈 메시지가 그대로 가는 것을 차단.
   */
  private _buildNotifyText(task: Task): string {
    const sid = task.agentSessionId;
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

  /**
   * orch /api/sessions/{caller}/intervene HTTP POST.
   *
   * 키 케이스 *고정* — orch `InterveneRequest` Pydantic 모델
   * (`orch-server/src/soulstream_server/api/session_models.py:37-41`) 정합:
   *   - text         : str
   *   - user         : str (=== "agent")
   *   - caller_info  : Optional[dict]   ← snake_case! `callerInfo`(camelCase)는 무시됨.
   *
   * Python `cross_node_relay.py:45-54` 정본과 같은 wire payload — 양 서버가 같은 키 케이스로
   * 일관 처리하여 atom F-11C 회로(cross-node fallback caller_info 누락) 차단.
   *
   * 응답 non-2xx 또는 fetch throw 모두 *child finalize에 throw 전파 금지*.
   */
  private async _relayCrossNode(
    callerSessionId: string,
    text: string,
    callerInfo: AgentCallerInfo,
    childId: string,
  ): Promise<void> {
    if (!this.orch) return;
    const url = `${this.orch.baseUrl}/api/sessions/${callerSessionId}/intervene`;
    const headers: Record<string, string> = {
      ...this.orch.headers,
      "content-type": "application/json",
    };
    const body = {
      text,
      user: "agent",
      caller_info: callerInfo,  // snake_case 의무 (Pydantic 필드명)
    };
    try {
      const resp = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const bodyText = await safeReadText(resp);
        this.logger.error(
          { childId, callerSessionId, status: resp.status, body: bodyText },
          "Cross-node completion notification: orch returned non-2xx",
        );
        return;
      }
      this.logger.info(
        { childId, callerSessionId },
        "Completion notification delivered via cross-node relay",
      );
    } catch (err) {
      this.logger.error(
        { err, childId, callerSessionId },
        "Cross-node completion notification failed",
      );
    }
  }
}

async function safeReadText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}
