import type { Logger } from "pino";

import type { CompletionSettlementLedger } from "./completion_settlement_store.js";
import type { Task } from "./task_models.js";

type Warn = Pick<Logger, "warn">;

/**
 * 종료 사건 하나가 올라가는 동안의 완료 정산 미결 기록이다. 아웃박스에 붙이기 전에 미결을
 * 영속하고(불변식 1), 붙은 뒤의 좌표와 중앙이 적용한 종료 사건 번호를 덧붙인다. 덧붙이기가
 * 실패해도 종료를 막지 않는다: 훑기가 아웃박스 줄을 종료 의미 키로 찾고 중앙 세션을 읽어 가른다.
 */
export class TerminalSettlementTrack {
  private appendedToOutbox = false;

  private constructor(
    private readonly ledger: CompletionSettlementLedger,
    private readonly logger: Warn,
    private readonly sessionId: string,
    readonly key: string,
    /** 앞 시도의 미결이 이미 있었다. 그 시도의 줄이 아웃박스에 있을 수 있다. */
    private readonly replacedEarlierAttempt: boolean,
  ) {}

  static async begin(
    ledger: CompletionSettlementLedger,
    logger: Warn,
    task: Task,
    key: string,
    registrationId: string | undefined,
  ): Promise<TerminalSettlementTrack> {
    const { replaced } = await ledger.begin({
      sessionId: task.agentSessionId,
      dedupeKey: key,
      registrationId: registrationId ?? null,
      executionCommandId: task.executionRegistration?.executionCommandId ?? null,
    });
    return new TerminalSettlementTrack(ledger, logger, task.agentSessionId, key, replaced);
  }

  /** 아웃박스에 붙은 직후, 응답을 기다리기 전에 부른다. */
  readonly onAppended = async (
    record: { stream_id: string; source_seq: number },
  ): Promise<void> => {
    this.appendedToOutbox = true;
    try {
      await this.ledger.recordAppended(this.key, {
        streamId: record.stream_id,
        sourceSeq: record.source_seq,
      });
    } catch (err) {
      this.logger.warn(
        { err, sessionId: this.sessionId },
        "completion settlement could not record the outbox coordinate; the sweep finds the line by key",
      );
    }
  };

  /**
   * 종료를 올리다 던졌다. 이번 시도가 붙지 못했고 앞 시도도 없었으면 지운다. 붙었거나 앞 시도의
   * 줄이 있을 수 있으면 쥠을 풀어 훑기에 맡긴다(훑기가 줄을 종료 의미 키로 찾는다).
   */
  async failed(): Promise<void> {
    if (this.appendedToOutbox || this.replacedEarlierAttempt) {
      this.ledger.release(this.key);
      return;
    }
    try {
      await this.ledger.discard(this.key);
    } catch (err) {
      this.logger.warn(
        { err, sessionId: this.sessionId },
        "completion settlement of an unappended terminal could not be removed",
      );
    }
  }

  async applied(terminationEventId: number | null): Promise<void> {
    if (terminationEventId === null) return;
    try {
      await this.ledger.recordApplied(this.key, terminationEventId);
    } catch (err) {
      this.logger.warn(
        { err, sessionId: this.sessionId },
        "completion settlement could not record the applied terminal event id",
      );
    }
  }

  release(): void {
    this.ledger.release(this.key);
  }
}

/** 정산을 마친 종료의 미결을 지운다. 지우지 못해도 훑기가 다시 닫으므로 흐름을 막지 않는다. */
export async function closeSettledTerminal(
  ledger: CompletionSettlementLedger | undefined,
  logger: Warn,
  sessionId: string,
  key: string | undefined,
): Promise<void> {
  if (!ledger || key === undefined) return;
  try {
    await ledger.close(key);
  } catch (err) {
    logger.warn(
      { err, sessionId },
      "completion settlement could not be closed after registration; the sweep closes it",
    );
  }
}
