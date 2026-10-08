import { describe, expect, it, vi } from "vitest";
import { buildCardChangeNotification } from "../src/cards/card_change_notification.js";
import { sendCardChangeOnce } from "../src/cards/card_change_delivery.js";
import type { CardMutationChange } from "../src/cards/card_control_plane_service.js";
import type { SessionDeliveryRow } from "../src/control_plane/control_plane_types.js";
import type { InterveneNodeCommandPayload } from "../src/session/session_action_command_payloads.js";
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
    expect(buildCardChangeNotification(c,{id:"comment-1",author_kind:"user",body:"추가 지시",delivered_at:null})).toMatchObject({text:"[카드 커멘트] 세션 other가 카드 「작업」(card)에 커멘트를 남겼습니다: 추가 지시\n커멘트 ID: comment-1\n카드 상태: 실행 중\n수정 지시면 항목을 하는 중으로 알리고 카드를 진행 중으로 옮긴 뒤 진행한다. 질문이면 답 커멘트만 남긴다.",deliveryId:"card:card:comment:op:owner"});
  });
  it("adds the card status, current target item state, confirmations, and next-step instruction",()=>{
    const c=change();c.result.operation.operation_type="add_card_comment";
    expect(buildCardChangeNotification(c,{id:"comment-2",author_kind:"user",body:"수정해 주세요",delivered_at:null},undefined,
      {itemTarget:{id:2,title:"검색 결과",state:"done",confirmed:false},confirmedItemIds:[1,2]})).toMatchObject({text:"[카드 커멘트] 사용자가 카드 「작업」(card)에 커멘트를 남겼습니다: 수정해 주세요\n커멘트 ID: comment-2\n카드 상태: 실행 중\n대상 항목: 2번 검색 결과 (지금 끝남)\n그동안 확인한 항목: 1번, 2번\n수정 지시면 항목을 하는 중으로 알리고 카드를 진행 중으로 옮긴 뒤 진행한다. 질문이면 답 커멘트만 남긴다."});
  });
  it.each([["todo","아직"],["doing","하는 중"],["done","끝남"],["dropped","뺌"]] as const)("labels current target item state %s",(state,label)=>{
    const c=change();c.result.operation.operation_type="add_card_comment";
    const notice=buildCardChangeNotification(c,{id:"comment-3",author_kind:"user",body:"확인해 주세요",delivered_at:null},undefined,
      {itemTarget:{id:2,title:"검색 결과",state,confirmed:false}});
    expect(notice?.text).toContain(`대상 항목: 2번 검색 결과 (지금 ${label})`);
  });
  it("labels a user-confirmed target item before its workflow state",()=>{
    const c=change();c.result.operation.operation_type="add_card_comment";
    const notice=buildCardChangeNotification(c,{id:"comment-4",author_kind:"user",body:"다시 봐 주세요",delivered_at:null},undefined,
      {itemTarget:{id:2,title:"검색 결과",state:"done",confirmed:true}});
    expect(notice?.text).toContain("대상 항목: 2번 검색 결과 (지금 사용자 확인)");
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

describe("card change delivery reuse",()=>{
  const payload={type:"intervene",agentSessionId:"owner",text:"카드 변경",user:"caller",delivery_id:"delivery-1",source:"card_change",relation_key:"relation-1",completion_id:"completion-1"} as unknown as InterveneNodeCommandPayload;
  const row=(overrides:Record<string,unknown>={})=>({delivery_id:"delivery-1",state:"pending",aggregate_state:"pending",...overrides}) as SessionDeliveryRow;
  it("keeps the existing three-argument register path",async()=>{
    const registered=row();
    const repository={
      register:vi.fn(async()=>({row:registered,inserted:true,conflict:false})),
      claim:vi.fn(async()=>row({state:"claimed"})),
      get:vi.fn(async()=>row({state:"queued",aggregate_state:"pending"})),
    };
    const send=vi.fn(async()=>({outcome:"queued"}));
    await sendCardChangeOnce(repository,payload,send);
    expect(repository.register).toHaveBeenCalledTimes(1);
    expect(repository.claim).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("reuses the exact registered row without registering again",async()=>{
    const registered=row();
    const repository={
      register:vi.fn(),
      claim:vi.fn(async()=>row({state:"claimed"})),
      get:vi.fn(async()=>row({state:"queued",aggregate_state:"pending"})),
    };
    const send=vi.fn(async()=>({outcome:"queued"}));
    await sendCardChangeOnce(repository,payload,send,registered);
    expect(repository.register).not.toHaveBeenCalled();
    expect(repository.claim).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not re-claim an already queued registered row",async()=>{
    const repository={register:vi.fn(),claim:vi.fn(),get:vi.fn()};
    const send=vi.fn();
    await sendCardChangeOnce(repository,payload,send,row({state:"queued"}));
    expect(repository.register).not.toHaveBeenCalled();
    expect(repository.claim).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects a registered row from another delivery identity",async()=>{
    const repository={register:vi.fn(),claim:vi.fn(),get:vi.fn()};
    await expect(sendCardChangeOnce(repository,payload,vi.fn(),row({delivery_id:"different-delivery"})))
      .rejects.toThrow("Card delivery identity mismatch");
    expect(repository.register).not.toHaveBeenCalled();expect(repository.claim).not.toHaveBeenCalled();
  });
});
