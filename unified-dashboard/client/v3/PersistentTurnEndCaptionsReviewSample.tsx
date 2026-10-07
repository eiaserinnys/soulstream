import { TurnEndCaptions } from "@seosoyoung/soul-ui/components/chat/TurnEndCaptions";
import { AssistantMessage } from "@seosoyoung/soul-ui/components/chat/AssistantMessage";
import { SystemMessage } from "@seosoyoung/soul-ui/components/chat/SystemMessage";

const usageCaption = {
  title: "컨텍스트 약 63% · 정가 $1.40",
  contextText: "컨텍스트 6,300 / 10,000 (63.0%)",
  completeText: "턴 완료 · 입력 1,200 · 출력 340 · 정가 $1.40 (세션 $4.20)",
};
const summaryCaption = {
  treeNodeId: "review-turn-summary",
  content: "요청한 화면 변경을 반영하고 실제 렌더 상태를 확인했습니다.",
};
const persistentInstructionCaption = {
  instructions: [{
    id: "review-instruction-1",
    text: "답변은 간결하게 작성합니다.",
    source_turns: ["T195", "T210"],
    action: "added" as const,
  }],
  capReached: false,
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
    <div data-testid="turn-end-instruction-recorded">
      <p className="v3-components-label">사용량 + 요약 + 지속 지시</p>
      <TurnEndCaptions
        treeNodeId="review-instruction-recorded"
        usageCaption={usageCaption}
        summaryCaption={summaryCaption}
        persistentInstructionCaption={persistentInstructionCaption}
      />
    </div>
    <div data-testid="turn-end-default-recorded">
      <p className="v3-components-label">일반 채팅 · 답변과 요약 뒤</p>
      <AssistantMessage msg={{
        id: "review-default-answer",
        role: "assistant",
        treeNodeId: "review-default-answer",
        treeNodeType: "assistant_message",
        content: "요청한 내용을 확인하고 답했습니다.",
      }} />
      <SystemMessage msg={{
        id: "review-default-summary",
        role: "system",
        treeNodeId: "review-default-summary",
        treeNodeType: "turn_summary",
        content: "요약: 요청한 내용을 확인했습니다.",
      }} />
      <SystemMessage msg={{
        id: "review-default-instruction-recorded",
        role: "system",
        treeNodeId: "review-default-instruction-recorded",
        treeNodeType: "persistent_instruction_recorded",
        content: "",
        persistentInstructionRecorded: persistentInstructionCaption,
      }} />
    </div>
    <div data-testid="turn-end-instruction-cap-only">
      <p className="v3-components-label">지속 지시 상한</p>
      <TurnEndCaptions
        treeNodeId="review-instruction-cap-only"
        persistentInstructionCaption={{ instructions: [], capReached: true }}
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
