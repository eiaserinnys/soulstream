import { expect, it } from "vitest";
import { buildCardBlockedNotice } from "../src/cards/card_board_notice.js";

it("formats an unassigned blocked card with its saved execution settings", () => {
  expect(buildCardBlockedNotice({
    id: "card-id", number: 953, title: "작업", blocked_detail: null, blocked_kind: "no_report",
    assignee_session_id: null, node_id: "card-node", assignee_agent_id: "roselin", model_preset: "terra",
  }, null)).toBe("[카드 막힘] 맡긴 카드 #953 「작업」(card-id)가 막혔습니다. 사유: 없음(no_report). 담당 세션 없음, 노드 card-node, 에이전트 roselin, 모델 terra. 담당이 이어 가지 못하는 막힘입니다. 다른 모델이나 노드로 담당을 바꿔 이어 가려면 dispatch_work에 card_id와 replace_assignee=true를 보내세요.");
});
