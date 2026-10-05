import { useMemo, useState } from "react";
import { ChatMessageItem } from "@seosoyoung/soul-ui/components/chat/ChatMessageItem";
import { createProcessingContext } from "@seosoyoung/soul-ui/stores/processing-context";
import { processEventsBatch } from "@seosoyoung/soul-ui/stores/event-processor";
import { flattenTree } from "@seosoyoung/soul-ui/lib/flatten-tree";
import { projectPersistentChatDisplayMessages } from "@seosoyoung/soul-ui/lib/persistent-jev-candidates";
import { SettingFieldWidget, type SettingField } from "../components/config/SettingFieldWidget";

const inputId = "components-review-input";
const emptyInputId = "components-review-empty-input";
const longInputId = "components-review-long-input";

function candidateObservation(input_id: string, selected: Array<{
  kind: "turn_summary" | "card" | "session";
  label: string;
  line: string;
  score: number;
  session_id?: string;
  summary_event_id?: number;
  turn_number?: number;
  card_id?: string;
}> = []) {
  return {
    input_id,
    selected,
    candidate_counts: { turn_summaries: 1, cards: 1, search_sessions: 1, recent_completed_sessions: 0 },
    model: "jev-latest",
    latency_ms: 12,
  };
}

function candidateEvent(input_id: string, selected: Parameters<typeof candidateObservation>[1]) {
  return {
    type: "debug",
    kind: "persistent_jev_candidates",
    timestamp: 5,
    observation: candidateObservation(input_id, selected),
  };
}

const candidateEvents = [
  candidateEvent(inputId, [
    { kind: "turn_summary", session_id: "review-session", summary_event_id: 38, turn_number: 38, label: "T38", line: "영구 세션 설정의 표시 토글", score: 3 },
    { kind: "card", card_id: "review-card", label: "#412", line: "후보 내용을 채팅에 표시", score: 2 },
    { kind: "session", session_id: "review-session-2", label: "PAS 웹 채팅", line: "같은 입력 아래에 기록 배치", score: 2 },
  ]),
  candidateEvent(emptyInputId, []),
  candidateEvent(longInputId, [
    { kind: "card", card_id: "review-long-card", label: "#413", line: "좁은 화면에서 한 줄 말줄임을 확인하기 위한 매우 긴 Jev 후보 설명 문장입니다", score: 3 },
  ]),
];

const generationField: SettingField = { key: "review-generation", field_name: "show_generation_separator", label: "세대 구분선 표시", description: "세대가 바뀐 자리에 구분선을 보여 줍니다.", value: true, value_type: "bool", sensitive: false, hot_reloadable: true, read_only: false };
const candidatesField: SettingField = { key: "review-candidates", field_name: "show_jev_candidates", label: "Jev 후보 표시", description: "내 입력 아래에 Jev가 찾은 후보를 접힌 줄로 보여 줍니다.", value: true, value_type: "bool", sensitive: false, hot_reloadable: true, read_only: false };

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
      { event: candidateEvents[0] as never, eventId: 6 },
      { event: { type: "user_message", timestamp: 6, text: "2점 이상인 후보는?", input_id: emptyInputId } as never, eventId: 7 },
      { event: candidateEvents[1] as never, eventId: 8 },
      { event: { type: "user_message", timestamp: 8, text: "긴 후보 설명을 확인해줘", input_id: longInputId } as never, eventId: 9 },
      { event: candidateEvents[2] as never, eventId: 10 },
    ], context, null, "components-review-pas", null, 0, true);
    return flattenTree(result.root);
  }, []);
  const visibleMessages = useMemo(() => projectPersistentChatDisplayMessages(messages, {
    show_generation_separator: showGeneration,
    show_jev_candidates: showCandidates,
  }), [messages, showGeneration, showCandidates]);

  return <div className="space-y-2" data-testid="persistent-chat-display-review-sample">
    <div>
      <SettingFieldWidget field={generationField} value={String(showGeneration)} onChange={(value) => setShowGeneration(value === "true")} />
      <SettingFieldWidget field={candidatesField} value={String(showCandidates)} onChange={(value) => setShowCandidates(value === "true")} />
    </div>
    {visibleMessages.map((msg) => <ChatMessageItem key={msg.treeNodeId} msg={msg} />)}
  </div>;
}
