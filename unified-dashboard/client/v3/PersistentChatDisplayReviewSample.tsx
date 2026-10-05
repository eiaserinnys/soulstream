import { useMemo, useState } from "react";
import { ChatMessageItem } from "@seosoyoung/soul-ui/components/chat/ChatMessageItem";
import { createProcessingContext } from "@seosoyoung/soul-ui/stores/processing-context";
import { processEventsBatch } from "@seosoyoung/soul-ui/stores/event-processor";
import { flattenTree } from "@seosoyoung/soul-ui/lib/flatten-tree";
import { SettingFieldWidget, type SettingField } from "../components/config/SettingFieldWidget";

const inputId = "components-review-input";
const candidateEvent = {
  type: "debug", kind: "persistent_jev_candidates", timestamp: 5,
  observation: { input_id: inputId, selected: [
    { kind: "turn_summary", session_id: "review-session", summary_event_id: 38, turn_number: 38, label: "T38", line: "영구 세션 설정의 표시 토글", score: 3 },
    { kind: "card", card_id: "review-card", label: "#412", line: "후보 내용을 채팅에 표시", score: 2 },
    { kind: "session", session_id: "review-session-2", label: "PAS 웹 채팅", line: "같은 입력 아래에 기록 배치", score: 2 },
  ], candidate_counts: { turn_summaries: 1, cards: 1, search_sessions: 1, recent_completed_sessions: 0 }, model: "jev-latest", latency_ms: 12 },
};
const generationField: SettingField = { key: "review-generation", field_name: "show_generation_separator", label: "세대 구분선 표시", description: "", value: true, value_type: "bool", sensitive: false, hot_reloadable: true, read_only: false };
const candidatesField: SettingField = { key: "review-candidates", field_name: "show_jev_candidates", label: "Jev 후보 표시", description: "", value: true, value_type: "bool", sensitive: false, hot_reloadable: true, read_only: false };

export function PersistentChatDisplayReviewSample() {
  const [showGeneration, setShowGeneration] = useState(true);
  const [showCandidates, setShowCandidates] = useState(true);
  const messages = useMemo(() => {
    const context = createProcessingContext();
    const result = processEventsBatch([
      { event: { type: "assistant_message", timestamp: 1, content: "이전 세대의 답변입니다.", tool_use_id: "review-before" } as never, eventId: 1 },
      { event: { type: "complete", timestamp: 1.5, result: "Session completed" } as never, eventId: 2 },
      { event: { type: "generation_started", timestamp: 2 } as never, eventId: 3 },
      { event: { type: "assistant_message", timestamp: 3, content: "새 세대의 답변입니다.", tool_use_id: "review-after" } as never, eventId: 4 },
      { event: { type: "user_message", timestamp: 4, text: "관련 후보를 찾아줘", input_id: inputId } as never, eventId: 5 },
      { event: candidateEvent as never, eventId: 6 },
    ], context, null, "components-review-pas", null, 0, true);
    return flattenTree(result.root);
  }, []);
  return <div className="space-y-2" data-testid="persistent-chat-display-review-sample">
    <div>
      <SettingFieldWidget field={generationField} value={String(showGeneration)} onChange={(value) => setShowGeneration(value === "true")} />
      <SettingFieldWidget field={candidatesField} value={String(showCandidates)} onChange={(value) => setShowCandidates(value === "true")} />
    </div>
    {messages.map((msg) => {
      if (msg.treeNodeType === "generation_started" && !showGeneration) return null;
      if (msg.treeNodeType === "persistent_jev_candidates" && !showCandidates) return null;
      return <ChatMessageItem key={msg.treeNodeId} msg={msg}/>;
    })}
  </div>;
}
