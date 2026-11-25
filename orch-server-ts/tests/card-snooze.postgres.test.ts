import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFolderContentSqlAdapter } from "../src/board/folder_content_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { appendCardEventTx } from "./card-work-postgres-fixture.js";

describe("카드 미루기 칸과 상태 이력", () => {
  let h: PagePostgresHarness;
  let cards: CardControlPlaneService;
  const user = { actorKind: "user" as const, actorSessionId: null, actorUserId: "director" };
  let sequence = 0;
  const key = () => `card-snooze:${++sequence}`;

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await h.sql`INSERT INTO folders(id,name) VALUES ('snooze','미루기')`;
    cards = new CardControlPlaneService(createFolderContentSqlAdapter(h.liveSql), { appendEventTx: appendCardEventTx },
      { emitCardUpdated: async () => {}, emitFolderUpdated: async () => {} });
  }, 60_000);
  afterAll(async () => h?.cleanup());

  it("snoozedUntil을 쓰고 지워도 상태와 확인 항목은 그대로이고 버전만 오른다", async () => {
    const created = await cards.createCard({ ...user, folderId: "snooze", title: "미루기", request: "요청", idempotencyKey: key() });
    const cardId = created.operation.target_id;
    const before = (await cards.getCard(cardId))!.card;
    expect(before.snoozed_until).toBeNull();

    const until = new Date(Date.now() + 86_400_000).toISOString();
    await cards.patchCard({ ...user, cardId, snoozedUntil: until, idempotencyKey: key() });
    const set = (await cards.getCard(cardId))!.card;
    expect(new Date(set.snoozed_until!).toISOString()).toBe(until);
    expect(set.status).toBe(before.status);
    expect(set.items).toEqual(before.items);
    expect(set.version).toBe(before.version + 1);

    await cards.patchCard({ ...user, cardId, snoozedUntil: null, idempotencyKey: key() });
    const cleared = (await cards.getCard(cardId))!.card;
    expect(cleared.snoozed_until).toBeNull();
    expect(cleared.status).toBe(before.status);
  });

  it("카드 상세의 statusHistory에 상태가 바뀐 기록만 오래된 순으로 나온다", async () => {
    const created = await cards.createCard({ ...user, folderId: "snooze", title: "이력", request: "요청", idempotencyKey: key() });
    const cardId = created.operation.target_id;
    await cards.setCardStatus({ ...user, cardId, status: "on_hold", idempotencyKey: key() });
    await cards.patchCard({ ...user, cardId, title: "이력 제목", idempotencyKey: key() });
    const { statusHistory } = (await cards.getCard(cardId))!;
    expect(statusHistory.length).toBeGreaterThanOrEqual(1);
    expect(statusHistory.at(-1)).toMatchObject({ status: "on_hold", actorKind: "user", sessionId: null });
    expect(Object.keys(statusHistory[0]!).sort()).toEqual(["actorKind", "at", "sessionId", "status"]);
  });
});
