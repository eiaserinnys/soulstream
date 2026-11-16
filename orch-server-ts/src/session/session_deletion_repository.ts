import { randomUUID } from "node:crypto";
import { FolderContentSqlResolver } from "../board/folder_content_sql.js";
import { makeCardNow } from "../cards/card_item_rules.js";
import { patchCardTx } from "../cards/control_plane/card_patch.js";
import type { CardRow } from "../cards/control_plane/card_types.js";
import { appendFolderOperation } from "../folders/folder_operation_store.js";
import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import type {
  SessionDeletionRepositoryPort,
} from "./session_deletion_service.js";

export type SessionDeletionCardUpdate = {
  readonly cardId: string;
  readonly folderId: string;
};

export type SessionDeletionRepositoryOptions = {
  /**
   * 트랜잭션이 커밋된 뒤 영향받은 카드마다 부른다. 커밋 전에 부르면 롤백과
   * 어긋나므로 트랜잭션 안에서는 부르지 않는다.
   */
  readonly onCardsUpdated?: (
    update: SessionDeletionCardUpdate,
  ) => void | Promise<void>;
};

export class SessionDeletionRepository implements SessionDeletionRepositoryPort {
  private readonly sqlResolver: FolderContentSqlResolver;
  private readonly options: SessionDeletionRepositoryOptions;

  constructor(
    resolver: LiveDbSqlResolver,
    options: SessionDeletionRepositoryOptions = {},
  ) {
    this.sqlResolver = new FolderContentSqlResolver(resolver);
    this.options = options;
  }

  async deleteSession(
    input: Parameters<SessionDeletionRepositoryPort["deleteSession"]>[0],
  ): Promise<void> {
    const sql = await this.sqlResolver.resolveSql();
    const updatedCards: SessionDeletionCardUpdate[] = [];
    await sql.begin(async (transaction) => {
      const cards = await transaction<CardRow[]>`
        SELECT * FROM cards WHERE limit_resume_session_id = ${input.sessionId} FOR UPDATE
      `;
      for (const card of cards) {
        const now = makeCardNow(
          { text: "담당이 바뀌어 자동 재개 예약을 해제했습니다", turn: "agent" },
          new Date().toISOString(),
          null,
        );
        await patchCardTx(transaction, card, {
          limit_resume_session_id: null,
          limit_resume_at: null,
          now: transaction.json(now),
        }, { actorKind: "system", actorSessionId: null }, null);
        await appendFolderOperation(transaction, {
          id: randomUUID(), folderId: card.folder_id, targetKind: "card", targetId: card.id,
          operationType: "update_card", actorKind: "system", actorEventId: null,
          payload: { limit_resume_session_id: null, limit_resume_at: null, now, deleted_session_id: input.sessionId },
        });
        updatedCards.push({ cardId: card.id, folderId: card.folder_id });
      }
      await transaction`SELECT session_delete(${input.sessionId})`;
    });
    for (const update of updatedCards) await this.options.onCardsUpdated?.(update);
  }
}
