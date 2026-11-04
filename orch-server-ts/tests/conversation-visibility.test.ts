import { describe, expect, it } from "vitest";
import { isCardNoticeInput, isHiddenConversationInput } from "../../packages/wire-schema/src/conversation_visibility.js";
import { buildCardBlockedNotice, buildCardDoneNotice, buildCardQuestionNotice, buildCardReviewNotice } from "../src/cards/card_board_notice.js";

const card = {id:"card",number:953,title:"작업"};
const notices = [
  buildCardBlockedNotice({...card,blocked_detail:null,blocked_kind:"limit",assignee_session_id:null,node_id:null,assignee_agent_id:null,model_preset:null},null),
  buildCardQuestionNotice(card,"질문?",["예"]),
  buildCardReviewNotice({...card,now:null,items:[]}),
  buildCardDoneNotice({...card,completed_kind:"user"}),
];

describe("card notice visibility", () => {
  it.each(notices)("recognizes the actual card notice for system inputs: %s", text => {
    for (const type of ["user_message","intervention_sent"]) {
      expect(isCardNoticeInput(type,{text,caller_info:{source:"system"}})).toBe(true);
      expect(isCardNoticeInput(type,{text,callerInfo:{source:"system"}})).toBe(true);
      expect(isHiddenConversationInput(type,{text,caller_info:{source:"system"}})).toBe(true);
      for (const source of ["browser","agent"]) expect(isCardNoticeInput(type,{text,caller_info:{source}})).toBe(false);
    }
    expect(isCardNoticeInput("assistant_message",{text,caller_info:{source:"system"}})).toBe(false);
  });
  it("hides keepalive inputs and keeps other system text visible", () => {
    expect(isHiddenConversationInput("user_message",{purpose:"cache_keepalive"})).toBe(true);
    expect(isHiddenConversationInput("assistant_message",{purpose:"cache_keepalive"})).toBe(false);
    expect(isCardNoticeInput("user_message",{text:"일반 메시지",caller_info:{source:"system"}})).toBe(false);
    expect(isCardNoticeInput("user_message",{text:"[카드 완료] 다른 내용",caller_info:{source:"system"}})).toBe(false);
  });
});
