import { TurnEndCaptions } from "@seosoyoung/soul-ui/components/chat/TurnEndCaptions";

const usageCaption = {
  title: "컨텍스트 약 63% · 정가 $1.40",
  contextText: "컨텍스트 6,300 / 10,000 (63.0%)",
  completeText: "턴 완료 · 입력 1,200 · 출력 340 · 정가 $1.40 (세션 $4.20)",
};
const summaryCaption = {
  treeNodeId: "review-turn-summary",
  content: "요청한 화면 변경을 반영하고 실제 렌더 상태를 확인했습니다.",
};

export function PersistentTurnEndCaptionsReviewSample() {
  return <div className="space-y-2" data-testid="persistent-turn-end-captions-review">
    <div data-testid="turn-end-usage-only">
      <p className="v3-components-label">사용량</p>
      <TurnEndCaptions treeNodeId="review-usage-only" usageCaption={usageCaption} />
    </div>
    <div data-testid="turn-end-summary-only">
      <p className="v3-components-label">요약</p>
      <TurnEndCaptions treeNodeId="review-summary-only" summaryCaption={summaryCaption} />
    </div>
    <div data-testid="turn-end-both">
      <p className="v3-components-label">사용량 + 요약</p>
      <TurnEndCaptions
        treeNodeId="review-turn-end"
        usageCaption={usageCaption}
        summaryCaption={summaryCaption}
      />
    </div>
    <div data-testid="turn-end-late-summary">
      <p className="v3-components-label">늦은 요약</p>
      <TurnEndCaptions
        treeNodeId="review-late-turn-end"
        usageCaption={usageCaption}
        summaryCaption={{ ...summaryCaption, treeNodeId: "review-late-summary" }}
      />
    </div>
  </div>;
}
