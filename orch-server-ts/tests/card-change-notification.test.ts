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
    expect(buildCardChangeNotification(c,{body:"추가 지시",delivered_at:null})).toMatchObject({text:"세션 other가 카드 「작업」(card)에 커멘트를 남겼습니다: 추가 지시",deliveryId:"card:card:comment:op:owner"});
  });
});
