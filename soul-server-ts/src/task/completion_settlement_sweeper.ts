import type { Logger } from "pino";

import type { SessionRow } from "../db/session_db_types.js";

import type {
  CompletionNotifyOptions,
  CompletionSettleResult,
} from "./completion_notifier.js";
import {
  nextGenerationContinues,
  type ScheduleReservation,
} from "./completion_skip_policy.js";
import type {
  CompletionSettlementEntry,
  CompletionSettlementStore,
} from "./completion_settlement_store.js";
import { DELIVERY_NOTIFICATION_MAX_AGE_MS } from "./session_delivery_notification_policy.js";
import { isActiveTaskStatus, isTaskStatus, type Task } from "./task_models.js";

/** 아웃박스가 종료 줄을 응답받았는지 보는 창이다. */
export interface SettlementOutboxView {
  readonly streamId: string;
  readonly ackedSeq: number;
  findBySemanticDedupeKey(key: string): Promise<{ source_seq: number } | null>;
}

export interface CompletionSettlementSweeperDeps {
  store: Pick<CompletionSettlementStore, "listUnheld" | "closeUnlessHeld" | "isSessionHeld">;
  outbox: SettlementOutboxView;
  /** 중앙 세션 한 줄을 캐시 없이 읽는다. 없으면 null이다. */
  readCentralSession(sessionId: string): Promise<SessionRow | null>;
  /** 중앙 세션 줄에서 완료 글과 수신자를 되살린 task를 만든다. */
  hydrate(row: SessionRow): Task | null;
  notifier: {
    notify(task: Task, options?: CompletionNotifyOptions): Promise<CompletionSettleResult | void>;
  };
  listReservations(sessionId: string): Promise<readonly ScheduleReservation[]>;
  logger: Pick<Logger, "info" | "warn" | "error">;
  now?: () => number;
}

/** 훑기가 미결을 닫는 까닭이다. 로그에만 쓴다. */
type CloseReason =
  | "registered"
  | "skipped"
  | "central_session_absent"
  | "central_session_running"
  | "terminal_not_applied"
  | "other_terminal_applied"
  | "superseded_by_newer_settlement"
  | "gave_up_after_max_age";

/**
 * 재시작 뒤와 주기로 완료 정산 미결을 훑는다. 정상 길이 쥔 미결은 건드리지 않는다.
 *
 * 아웃박스가 종료를 아직 응답받지 않았으면 기다린다(아웃박스가 보낸다). 응답받았으면 중앙
 * 세션을 읽어 우리 종료가 적용됐는지 본 뒤에만 완료 전달을 등록한다. 중앙 읽기가 실패했거나
 * 등록을 다시 해야 하면 남겨 두고 다음 주기에 다시 본다. 러너 등록과 정상 보유에 기대지 않는다.
 */
export class CompletionSettlementSweeper {
  constructor(private readonly deps: CompletionSettlementSweeperDeps) {}

  async sweepOnce(): Promise<void> {
    const entries = await this.deps.store.listUnheld();
    for (const entry of entries) {
      try {
        await this.settle(entry, entries);
      } catch (err) {
        this.deps.logger.warn(
          { err, sessionId: entry.sessionId, dedupeKey: entry.dedupeKey },
          "completion settlement sweep failed for an entry; it stays pending",
        );
      }
    }
  }

  private async settle(
    entry: CompletionSettlementEntry,
    entries: readonly CompletionSettlementEntry[],
  ): Promise<void> {
    // 종료 번호를 받지 못한 옛 미결은 어느 종료의 것인지 중앙으로 가를 수 없다. 같은 세션에 더 새로
    // 만든 미결이 있으면 그 미결이 이 세션의 보고를 맡는다(지금 중앙의 종료로 등록하면 새 종료의
    // 정상 길과 본문이 달라 orch가 먼저 선 줄을 죽인다).
    if (
      entry.terminationEventId === undefined
      && entries.some((other) =>
        other.sessionId === entry.sessionId
        && other.dedupeKey !== entry.dedupeKey
        && Date.parse(other.createdAt) > Date.parse(entry.createdAt))
    ) {
      return await this.close(entry, "superseded_by_newer_settlement");
    }
    let acknowledged: boolean;
    try {
      acknowledged = await this.outboxAcknowledged(entry);
    } catch (err) {
      // 아웃박스 조회가 계속 던지면 이 미결이 러너 은퇴를 영구히 막는다. 시도한 것으로 세어 나이로 접는다.
      this.deps.logger.warn(
        { err, sessionId: entry.sessionId, dedupeKey: entry.dedupeKey },
        "completion settlement could not look up the outbox line; it stays pending",
      );
      return await this.giveUpIfTooOld(entry);
    }
    if (!acknowledged) return;
    let row: SessionRow | null;
    try {
      row = await this.deps.readCentralSession(entry.sessionId);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: entry.sessionId },
        "completion settlement could not read the central session; it stays pending",
      );
      return await this.giveUpIfTooOld(entry);
    }
    if (row === null) return await this.close(entry, "central_session_absent");
    if (isTaskStatus(row.status) && isActiveTaskStatus(row.status)) {
      return await this.close(entry, "central_session_running");
    }
    const centralEventId = row.termination_event_id;
    if (centralEventId === null || centralEventId === undefined) {
      return await this.close(entry, "terminal_not_applied");
    }
    // 번호가 있으면 우리 종료인지 대조한다. 번호가 없으면(응답을 받기 전에 죽음) 중앙에
    // 적용된 지금 종료로 등록한다. 더 새 종료의 정상 길과 겹치지 않도록 위의 더 새 미결 검사와,
    // 목록을 읽은 뒤 정상 길이 쥔 세션을 건너뛰는 아래 검사가 막는다.
    if (entry.terminationEventId !== undefined && entry.terminationEventId !== centralEventId) {
      return await this.close(entry, "other_terminal_applied", {
        entryEventId: entry.terminationEventId,
        centralEventId,
      });
    }
    const task = this.deps.hydrate(row);
    if (task === null) {
      this.deps.logger.warn(
        { sessionId: entry.sessionId },
        "completion settlement could not restore the central session row; it stays pending",
      );
      return await this.giveUpIfTooOld(entry);
    }
    // 오류 본문은 종료 상세가 그대로 담고 있다.
    if (task.status === "error" && !task.error) task.error = task.terminationDetail ?? undefined;
    this.deps.logger.warn(
      { sessionId: entry.sessionId, terminalEventId: centralEventId },
      "completion text restored from the central session row; limit text, background notice and portrait are not restored",
    );
    let result: CompletionSettleResult | void;
    try {
      const continues = await nextGenerationContinues(
        task,
        this.deps.listReservations,
      );
      // 중앙을 읽는 사이 정상 길이 이 세션의 새 종료를 쥐었다면 등록하지 않는다(그 길이 보고를 맡는다).
      if (this.deps.store.isSessionHeld(entry.sessionId)) return;
      result = await this.deps.notifier.notify(task, {
        nextGenerationContinues: continues,
      });
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId: entry.sessionId },
        "completion settlement could not register the completion; it stays pending",
      );
      return await this.giveUpIfTooOld(entry);
    }
    if (result && result.kind === "retry_required") return await this.giveUpIfTooOld(entry);
    await this.close(entry, result?.kind === "skipped" ? "skipped" : "registered");
  }

  /**
   * 한 번 시도한 뒤 다시 해야 함이나 읽기 실패(아웃박스 조회 포함)로 끝난 미결만 나이로 접는다. 등록이 영영 되지 않는
   * 미결(부른 세션이 없어졌거나 중앙 줄을 되살릴 수 없음)이 러너 은퇴를 영구히 막지 않도록
   * 완료 전달 장부의 재시도 나이 한도에서 접는다. 시도하지 않은 미결은 나이로 닫지 않는다.
   */
  private async giveUpIfTooOld(entry: CompletionSettlementEntry): Promise<void> {
    const ageMs = (this.deps.now ?? Date.now)() - Date.parse(entry.createdAt);
    if (ageMs <= DELIVERY_NOTIFICATION_MAX_AGE_MS) return;
    this.deps.logger.error(
      { sessionId: entry.sessionId, dedupeKey: entry.dedupeKey, ageMs },
      "completion settlement gave up: the completion could not be registered within the retry age limit",
    );
    await this.close(entry, "gave_up_after_max_age");
  }

  private async outboxAcknowledged(entry: CompletionSettlementEntry): Promise<boolean> {
    const { outbox } = this.deps;
    if (entry.sourceSeq !== undefined) {
      // 아웃박스가 교체됐으면 그 줄은 이 아웃박스에 없다. 기다려도 오지 않으므로 중앙을 본다.
      if (entry.streamId !== outbox.streamId) return true;
      return entry.sourceSeq <= outbox.ackedSeq;
    }
    // 좌표를 적기 전에 죽었다. 줄이 아직 있으면 그 줄이 응답받았는지 보고, 없으면(압축이 지웠거나
    // 붙이기 전에 죽음) 중앙이 가른다.
    const line = await outbox.findBySemanticDedupeKey(entry.dedupeKey);
    if (line === null) return true;
    return line.source_seq <= outbox.ackedSeq;
  }

  private async close(
    entry: CompletionSettlementEntry,
    reason: CloseReason,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    const closed = await this.deps.store.closeUnlessHeld(entry.dedupeKey);
    this.deps.logger.info(
      { sessionId: entry.sessionId, dedupeKey: entry.dedupeKey, reason, closed, ...detail },
      "completion settlement closed",
    );
  }
}
