import type { Logger } from "pino";

import type { Env } from "../config.js";
import type { SessionDB } from "../db/session_db.js";
import type { RunnerSettlementPendingProbe } from "../runner/runner_registration_control.js";
import type { SoulstreamScheduleService } from "../schedule/schedule_service.js";
import type { CompletionNotifier } from "../task/completion_notifier.js";
import { CompletionSettlementSweeper } from "../task/completion_settlement_sweeper.js";
import { CompletionSettlementStore } from "../task/completion_settlement_store.js";
import { CompletionSettlementWorker } from "../task/completion_settlement_worker.js";
import { hydrateEvictedTaskFromSessionRow } from "../task/task_evicted_hydration.js";
import type { TerminationCleanupPorts } from "../task/task_lifecycle_transition.js";
import { terminalDedupeKeyOf } from "../task/task_termination.js";
import type { EventOutbox } from "../upstream/event_outbox.js";

export interface CompletionSettlementComposition {
  store: CompletionSettlementStore;
  worker: CompletionSettlementWorker;
  /** 러너 복구가 은퇴와 거둠 전에 묻는다. 미결이 남은 등록은 은퇴하지 않는다. */
  hasPendingRunnerSettlement: RunnerSettlementPendingProbe;
  /**
   * 종료 정리 포트를 두 소유자(task manager, task executor)에 잇는다. 정산 저장소는 완료 전달
   * v2가 켜진 노드에서만 잇는다(꺼진 노드는 등록을 확인할 장부가 없다). 닫는 길은 플래그와 무관하게
   * 잇는다: 플래그를 끄기 전에 남은 미결도 닫혀야 한다.
   */
  wireTerminationCleanup(options: {
    owners: readonly { setTerminationCleanupPorts(ports: TerminationCleanupPorts): void }[];
    /** 러너 복구가 없는 노드는 없다. 없으면 거절된 종료 표시를 지울 주체가 없다. */
    retireRejectedRegistration: TerminationCleanupPorts["retireRejectedRegistration"];
    forgetTask: NonNullable<TerminationCleanupPorts["forgetTask"]>;
  }): void;
}

/** 완료 정산 미결의 저장소, 훑기, 공급자, 닫는 길을 한 곳에서 조립한다. */
export function composeCompletionSettlement(options: {
  env: Pick<Env, "EVENT_OUTBOX_DIR" | "CLAUDE_SESSION_RUNTIME_V2_ENABLED">;
  logger: Logger;
  db: Pick<SessionDB, "getSession">;
  eventOutbox: Pick<EventOutbox, "streamId" | "ackedSeq" | "findBySemanticDedupeKey">;
  completionNotifier: CompletionNotifier;
  scheduleService: Pick<SoulstreamScheduleService, "listSchedules">;
}): CompletionSettlementComposition {
  const { env, logger, db } = options;
  const store = new CompletionSettlementStore(env.EVENT_OUTBOX_DIR, logger);
  const sweeper = new CompletionSettlementSweeper({
    store,
    outbox: options.eventOutbox,
    readCentralSession: (sessionId) => db.getSession(sessionId),
    hydrate: (row) => hydrateEvictedTaskFromSessionRow(row, logger),
    notifier: options.completionNotifier,
    listReservations: async (sessionId) =>
      (await options.scheduleService.listSchedules(sessionId)).schedules,
    logger,
  });
  const worker = new CompletionSettlementWorker({ sweepOnce: () => sweeper.sweepOnce(), logger });
  return {
    store,
    worker,
    hasPendingRunnerSettlement: async (registration) =>
      await store.hasPendingForSession(registration.config.sessionId),
    wireTerminationCleanup: ({ owners, retireRejectedRegistration, forgetTask }) => {
      const ports: TerminationCleanupPorts = {
        ...(retireRejectedRegistration ? { retireRejectedRegistration } : {}),
        forgetTask,
        closeSettlementPending: async (task) => {
          const key = terminalDedupeKeyOf(task);
          if (key === undefined) await store.closeAllForSession(task.agentSessionId);
          else await store.close(key);
        },
        ...(env.CLAUDE_SESSION_RUNTIME_V2_ENABLED ? { settlement: store } : {}),
      };
      for (const owner of owners) owner.setTerminationCleanupPorts(ports);
    },
  };
}
