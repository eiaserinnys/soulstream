import { describe, expect, it } from "vitest";
import { buildCardChangeNotification } from "../src/cards/card_change_notification.js";
import type { CardMutationChange } from "../src/cards/card_control_plane_service.js";
const change = (overrides: Record<string,unknown> = {}) => ({
  previousStatus:"queued",previousAssigneeSessionId:"owner",committedCard:{id:"card",title:"작업",status:"running",assignee_session_id:"owner"},
  result:{operation:{id:"op",target_id:"card",operation_type:"set_card_status",actor_kind:"user",actor_session_id:null,payload_json:{status:"running"}},snapshot:{cards:[]}},...overrides,
}) as unknown as CardMutationChange;
describe("committed card reference notifications",()=>{
  it("uses actual actor, locked before/after state and exact owner",()=>{
    expect(buildCardChangeNotification(change())).toMatchObject({sessionId:"owner",text:"사용자가 카드 「작업」(card)를 대기→실행 중으로 변경했습니다",deliveryId:"card:card:state:op:owner"});
  });
  it.each([change({previousStatus:"running"}),change({previousAssigneeSessionId:null}),change({committedCard:{id:"card",status:"done"}}),change({result:{idempotent:true,operation:{}}}),change({result:{operation:{actor_kind:"agent",actor_session_id:"owner",operation_type:"set_card_status"}}})])("suppresses no-change, unowned, done, replay, own changes",c=>expect(buildCardChangeNotification(c)).toBeNull());
  it("labels another session honestly even when comment.author_kind says user",()=>{
    const c=change();c.result.operation.actor_kind="agent";c.result.operation.actor_session_id="other";c.result.operation.operation_type="add_card_comment";
    expect(buildCardChangeNotification(c,{id:"comment-1",author_kind:"user",body:"추가 지시",delivered_at:null})).toMatchObject({text:"세션 other가 카드 「작업」(card)에 커멘트를 남겼습니다: 추가 지시\n커멘트 ID: comment-1",deliveryId:"card:card:comment:op:owner"});
  });
  it("adds the target item and item confirmations after the user comment",()=>{
    const c=change();c.result.operation.operation_type="add_card_comment";
    expect(buildCardChangeNotification(c,{id:"comment-2",author_kind:"user",body:"수정해 주세요",delivered_at:null},undefined,
      {itemTarget:{id:2,title:"검색 결과"},confirmedItemIds:[1,2]})).toMatchObject({text:"사용자가 카드 「작업」(card)에 커멘트를 남겼습니다: 수정해 주세요\n커멘트 ID: comment-2\n대상 항목: 2번 검색 결과\n그동안 확인한 항목: 1번, 2번"});
  });
  it("never delivers an agent reply as a new owner input",()=>{
    const c=change();c.result.operation.actor_kind="agent";c.result.operation.actor_session_id="other";c.result.operation.operation_type="add_card_comment";
    expect(buildCardChangeNotification(c,{author_kind:"agent",body:"확인한 답변",delivered_at:null})).toBeNull();
  });
  it("delivers a user comment on a completed card while suppressing completion state notifications",()=>{
    const c=change();c.committedCard!.status="done";c.result.operation.operation_type="add_card_comment";
    expect(buildCardChangeNotification(c,{author_kind:"user",body:"보완 요청",delivered_at:null})).toMatchObject({sessionId:"owner",text:expect.stringContaining("보완 요청")});
    c.result.operation.operation_type="set_card_status";
    expect(buildCardChangeNotification(c)).toBeNull();
  });
});
