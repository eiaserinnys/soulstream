import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBoardYjsSqlAdapter } from "../src/board-yjs/board_yjs_sql.js";
import { CardControlPlaneService } from "../src/cards/card_control_plane_service.js";
import { registerCardRoutes } from "../src/cards/card_routes.js";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";
import { appendCardEventTx } from "./card-work-postgres-fixture.js";

describe("card check-item locked mutations", () => {
  let h: PagePostgresHarness;
  let cards: CardControlPlaneService;
  let peerCards: CardControlPlaneService;
  const onMutation = vi.fn();
  const peerOnMutation = vi.fn();
  const cardUpdated = vi.fn(async () => {});
  let sequence = 0;
  const key = () => `card-items:${++sequence}`;
  const user = { actorKind: "user" as const, actorSessionId: null, actorUserId: "director" };
  const assignee = { actorKind: "agent" as const, actorSessionId: "owner" };

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await h.sql`INSERT INTO folders(id,name) VALUES ('items','확인 항목')`;
    await h.sql`INSERT INTO sessions(session_id,status) VALUES ('owner','running'),('other','running')`;
    const broadcaster = { emitCardUpdated: cardUpdated, emitFolderUpdated: async () => {} };
    cards = new CardControlPlaneService(createBoardYjsSqlAdapter(h.liveSql), { appendEventTx: appendCardEventTx }, broadcaster, onMutation);
    peerCards = new CardControlPlaneService(createBoardYjsSqlAdapter(h.peerLiveSql), { appendEventTx: appendCardEventTx }, broadcaster, peerOnMutation);
  }, 60_000);

  afterAll(async () => h?.cleanup());

  beforeEach(async () => {
    await h.sql`DELETE FROM folder_operations WHERE folder_id='items'`;
    await h.sql`DELETE FROM cards WHERE folder_id='items'`;
    onMutation.mockClear();
    peerOnMutation.mockClear();
    cardUpdated.mockClear();
  });

  async function makeCard(title = "확인 항목 카드", sessionId = "owner") {
    const created = await cards.createCard({
      ...user,
      folderId: "items",
      title,
      request: "요청 원문",
      assignee: { kind: "session", sessionId },
      idempotencyKey: key(),
    });
    return created.operation.target_id;
  }

  it("stores a set and report under the card lock, confirms it, then opens one fix from a user comment", async () => {
    const cardId = await makeCard();
    await expect(cards.setCardItems({ actorKind: "agent", actorSessionId: "other", cardId, items: ["틀린 담당"] }))
      .rejects.toMatchObject({ statusCode: 422 });

    const set = await cards.setCardItems({ ...assignee, cardId, items: ["로그인 성공 확인"] });
    expect(set.operation.operation_type).toBe("set_card_items");
    let detail = await cards.getCard(cardId);
    expect(detail!.card.items).toMatchObject([{ id: 1, title: "로그인 성공 확인", state: "todo", result: null, confirmed: null }]);
    expect(detail!.card.version).toBe(2);

    const beforeRejectedReport = detail!.card.version;
    await expect(cards.reportCardItem({ ...assignee, cardId, itemId: 1, state: "done" }))
      .rejects.toMatchObject({ statusCode: 422, message: "결과 한 줄(result)이 필요합니다" });
    expect((await cards.getCard(cardId))!.card.version).toBe(beforeRejectedReport);
    expect(await h.sql`SELECT id FROM folder_operations WHERE target_id=${cardId} AND operation_type='report_card_item'`).toHaveLength(0);

    const report = await cards.reportCardItem({ ...assignee, cardId, itemId: 1, state: "done", result: "로그인 후 화면이 열립니다" });
    expect(report.operation.operation_type).toBe("report_card_item");
    expect((await cards.getCard(cardId))!.card.items).toMatchObject([{ state: "done", result: "로그인 후 화면이 열립니다", rev: 1 }]);

    onMutation.mockClear();
    cardUpdated.mockClear();
    const confirmed = await cards.confirmCardItem({ ...user, cardId, itemId: 1, confirmed: true });
    expect(confirmed.operation.operation_type).toBe("confirm_card_item");
    expect(onMutation).not.toHaveBeenCalled();
    expect(cardUpdated).toHaveBeenCalledTimes(1);
    expect((await cards.getCard(cardId))!.card.items).toMatchObject([{ confirmed: { rev: 1 }, fixOpen: 0 }]);
    await expect(cards.setCardItems({ ...assignee, cardId, items: ["교체 시도"] }))
      .rejects.toMatchObject({ statusCode: 422, message: "이미 결과나 확인이 달린 항목이 있습니다. 새 항목은 add_card_item으로 더하세요" });
    await expect(cards.reportCardItem({ ...assignee, cardId, itemId: 1, state: "dropped" }))
      .rejects.toMatchObject({ statusCode: 422, message: "사용자가 확인한 항목은 뺄 수 없습니다" });

    const comment = await cards.addComment({ ...user, cardId, body: "로그인 버튼을 눌러도 화면이 열리지 않아요", itemId: 1, idempotencyKey: key() });
    expect(comment).toMatchObject({ item_id: 1, body: "로그인 버튼을 눌러도 화면이 열리지 않아요" });
    detail = await cards.getCard(cardId);
    expect(detail!.card.items).toMatchObject([{ confirmed: null, fixOpen: 1 }]);
    expect(detail!.card.version).toBe(5);
  });

  it("requires a same-card user source and serializes concurrent confirmations without a version token", async () => {
    const cardId = await makeCard();
    const otherCardId = await makeCard("출처가 다른 카드", "other");
    await cards.setCardItems({ ...assignee, cardId, items: ["첫째", "둘째"] });
    await cards.setCardItems({ actorKind: "agent", actorSessionId: "other", cardId: otherCardId, items: ["다른 카드 항목"] });
    await h.sql`INSERT INTO card_comments(id,card_id,author_kind,kind,body)
      VALUES ('source-user',${cardId},'user','comment','확인해 주세요'),
        ('source-other',${otherCardId},'user','comment','다른 카드'),
        ('source-note',${cardId},'agent','note','내부 메모'),
        ('source-agent',${cardId},'agent','comment','에이전트 답')`;

    for (const fromCommentId of ["missing", "source-other", "source-note", "source-agent"]) {
      await expect(cards.addCardItem({ ...assignee, cardId, title: "잘못된 출처", fromCommentId }))
        .rejects.toMatchObject({ statusCode: 422, message: "항목은 사용자의 글에서만 더할 수 있습니다. from_comment_id에 사용자 커멘트를 지정하세요" });
    }
    const added = await cards.addCardItem({ ...assignee, cardId, title: "사용자 요청 항목", fromCommentId: "source-user" });
    expect(added.operation.operation_type).toBe("add_card_item");
    expect((await cards.getCard(cardId))!.card.items).toMatchObject([
      {}, {}, { id: 3, title: "사용자 요청 항목", from: { commentId: "source-user", kind: "comment" } },
    ]);
    for (const title of ["넷째", "다섯째", "여섯째"]) {
      await cards.addCardItem({ ...assignee, cardId, title, fromCommentId: "source-user" });
    }
    const beforeRejectedAdd = await h.sql`SELECT payload_json FROM folder_operations WHERE target_id=${cardId} AND operation_type='add_card_item'`;
    await expect(cards.addCardItem({ ...assignee, cardId, title: "일곱째", fromCommentId: "source-user" }))
      .rejects.toMatchObject({ statusCode: 422, message: "확인하지 않은 항목이 여섯입니다. 사용자의 확인을 기다리세요" });
    expect(await h.sql`SELECT payload_json FROM folder_operations WHERE target_id=${cardId} AND operation_type='add_card_item'`).toHaveLength(beforeRejectedAdd.length);

    onMutation.mockClear();
    peerOnMutation.mockClear();
    cardUpdated.mockClear();
    await Promise.all([
      cards.confirmCardItem({ ...user, cardId, itemId: 1, confirmed: true }),
      peerCards.confirmCardItem({ ...user, cardId, itemId: 2, confirmed: true }),
    ]);
    const concurrentItems = (await cards.getCard(cardId))!.card.items;
    expect(concurrentItems).toHaveLength(6);
    expect(concurrentItems.slice(0, 2)).toMatchObject([
      { id: 1, confirmed: { rev: 0 } }, { id: 2, confirmed: { rev: 0 } },
    ]);
    expect(await h.sql`SELECT id FROM folder_operations WHERE target_id=${cardId} AND operation_type='confirm_card_item'`).toHaveLength(2);
    expect(onMutation).not.toHaveBeenCalled();
    expect(peerOnMutation).not.toHaveBeenCalled();
    expect(cardUpdated).toHaveBeenCalledTimes(2);
  });

  it("confirms and unconfirms through the user REST path without a version token",async()=>{
    const cardId=await makeCard();
    await cards.setCardItems({...assignee,cardId,items:["확인 결과"]});
    const app=Fastify();
    registerCardRoutes(app,{provider:{listFolders:()=>[{id:"items"}],listSessionAssignments:()=>({})},
      accessProvider:{resolveAccess:()=>({restricted:false})},resolveDashboardUserId:()=>"director",
      cardServiceProvider:async()=>cards,authBearerToken:"service",environment:"test"});
    try{
      const agentConfirm=await app.inject({method:"POST",url:`/api/cards/${cardId}/items/1/confirm`,
        headers:{authorization:"Bearer service","x-soulstream-agent-session-id":"owner"},payload:{confirmed:true}});
      expect(agentConfirm.statusCode).toBe(403);
      const extraField=await app.inject({method:"POST",url:`/api/cards/${cardId}/items/1/confirm`,payload:{confirmed:true,expectedVersion:2}});
      expect(extraField.statusCode).not.toBe(200);
      for(const confirmed of [true,false,true]){
        const response=await app.inject({method:"POST",url:`/api/cards/${cardId}/items/1/confirm`,payload:{confirmed}});
        expect(response.statusCode,response.body).toBe(200);
        expect(response.json().card.items[0]).toMatchObject({confirmed:confirmed?expect.objectContaining({rev:0}):null,
          display:confirmed?"confirmed":"todo"});
      }
      expect((await cards.getCard(cardId))!.card.status).toBe("todo");
    }finally{await app.close();}
  });

  it("keeps old report writes and rejects them only for cards with check items", async () => {
    const oldCardId = await makeCard("옛 카드", "other");
    await expect(cards.addReport({ actorKind: "agent", actorSessionId: "other", cardId: oldCardId, title: "보고", format: "markdown", body: "기존 보고" }))
      .resolves.toMatchObject({ operation: { operation_type: "add_card_report" } });

    const newCardId = await makeCard("새 카드");
    await cards.setCardItems({ ...assignee, cardId: newCardId, items: ["첫째"] });
    const before = (await cards.getCard(newCardId))!.card.version;
    await expect(cards.addReport({ ...assignee, cardId: newCardId, title: "보고", format: "markdown", body: "옛 형식 결과" }))
      .rejects.toMatchObject({ statusCode: 422, message: "결과는 항목에 다세요(report_card_item)" });
    expect((await cards.getCard(newCardId))!.card.version).toBe(before);
    expect(await h.sql`SELECT id FROM card_reports WHERE card_id=${newCardId}`).toHaveLength(0);

    await expect(cards.requestCardReview({ ...assignee, cardId: newCardId }))
      .rejects.toMatchObject({ statusCode: 422, message: "사용자가 볼 것을 ask에 한 줄로 적으세요" });
    const review = await cards.requestCardReview({ ...assignee, cardId: newCardId, ask: "로그인 화면에서 확인해 주세요" });
    expect(review.operation.operation_type).toBe("set_card_status");
    let current = (await cards.getCard(newCardId))!.card;
    expect(current).toMatchObject({ status: "review", now: { text: "로그인 화면에서 확인해 주세요", turn: "user", ask: "로그인 화면에서 확인해 주세요", sessionId: "owner" } });

    const question = "가".repeat(61);
    await cards.askQuestion({ ...assignee, cardId: newCardId, text: question });
    current = (await cards.getCard(newCardId))!.card;
    expect(current).toMatchObject({ status: "blocked", now: { turn: "user", ask: `${"가".repeat(59)}…`, sessionId: "owner" } });

    const versionBeforeNote = current.version;
    const note = await cards.addCardNote({ ...assignee, cardId: newCardId, text: "내부 구현 메모" });
    expect(note).toMatchObject({ author_kind: "agent", kind: "note", session_id: "owner", body: "내부 구현 메모" });
    expect((await cards.getCard(newCardId))!.card.version).toBe(versionBeforeNote);
    await expect(cards.addCardNote({ ...assignee, cardId: newCardId, text: "한".repeat(4001) }))
      .rejects.toMatchObject({ statusCode: 422, message: "note.text은 4000자까지입니다. 지금 4001자입니다" });
  });

  it("paginates notes newest-first and exposes only explicit situation-board updates in history",async()=>{
    const cardId=await makeCard();
    for(let index=0;index<22;index++)
      await cards.addCardNote({...assignee,cardId,text:`내부 노트 ${index+1}`,idempotencyKey:key()});
    await cards.updateCardNow({...assignee,cardId,now:"첫 상황",turn:"agent",idempotencyKey:key()});
    await cards.askQuestion({...assignee,cardId,text:"사용자 판단 질문",idempotencyKey:key()});
    await cards.updateCardNow({...assignee,cardId,now:"다음 상황",turn:"user",ask:"새 화면을 확인해 주세요",idempotencyKey:key()});
    const first=await cards.listCardNotes({...assignee,cardId,limit:20});
    expect(first.notes).toHaveLength(20);
    expect(first.notes[0]).toMatchObject({body:"내부 노트 22"});
    expect(first.notes.at(-1)).toMatchObject({body:"내부 노트 3"});
    expect(first.nextCursor).toBe(first.notes.at(-1)!.id);
    const second=await cards.listCardNotes({...assignee,cardId,limit:20,before:first.nextCursor!});
    expect(second.notes).toMatchObject([{body:"내부 노트 2"},{body:"내부 노트 1"}]);
    expect(second.nextCursor).toBeNull();
    await expect(cards.listCardNotes({...assignee,cardId,before:"other-card-note"}))
      .rejects.toMatchObject({statusCode:422,message:"이 카드의 노트 커서를 지정하세요"});
    const detail=(await cards.getCard(cardId))!;
    expect(detail.comments).toHaveLength(0);
    expect(detail.notes).toHaveLength(22);
    expect(detail.nowHistory).toHaveLength(2);
    expect(detail.nowHistory.map(entry=>entry.text)).toEqual(["첫 상황","다음 상황"]);
    const serialized=(await import("../src/cards/card_operations.js")).serializeCardDetail(detail);
    expect(serialized.reports).toEqual([]);
    expect(serialized.card).toMatchObject({items:[],now:{text:"다음 상황"}});
    expect(serialized.notes[0]).toMatchObject({itemId:null,body:"내부 노트 1"});
    expect(serialized.nowHistory[0]).toMatchObject({text:"첫 상황",turn:"agent",ask:null,at:expect.any(String)});
  });
});
