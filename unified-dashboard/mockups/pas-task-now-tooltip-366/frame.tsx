import { useEffect } from "react";
import type { CardRow } from "@seosoyoung/soul-ui/cards/card-types";
import { DashboardInternalLinks } from "../../client/v3/DashboardInternalLinks";
import { PersistentSessionScreen } from "../../client/v3/PersistentSessionScreen";
import { reviewCard } from "../../client/v3/components-review-fixtures";
import { reportReviewEntries } from "../../client/v3/persistent-report-review-data";
import { mountMockup } from "../_shell/MockupShell";
import { mockApi, mockImages } from "../_shell/mock-env";

const now = "2026-10-14T05:30:00.000Z";
const settings = {
  default_model: { model_preset: null, reasoning_effort: null },
  fallback_model: null,
  show_generation_separator: true,
  show_character: true,
  animate_character: false,
  show_jev_candidates: true,
  show_turn_usage: true,
  turn_usage_mode: "collapsed" as const,
};

const persistentSession = {
  session_id: "pas-main",
  display_name: "PAS 대화",
  node_id: "eiaserinnys",
  folder_id: null,
  agent_id: "roselin_codex",
  agent_name: "로젤린",
  persistent: true,
  persistent_report: reportReviewEntries,
  settings,
  runtime: { current_model: { model_preset: null, reasoning_effort: null, model: "codex" }, pending: null },
};

const session = {
  agentSessionId: "pas-main",
  displayName: "PAS 대화",
  status: "running",
  eventCount: 1,
  createdAt: now,
  updatedAt: now,
  nodeId: "eiaserinnys",
  agentId: "roselin_codex",
  agentName: "로젤린",
  backend: "codex",
  prompt: "PAS 작업 목록 호버 툴팁 시안",
};

const card = (id: string, number: number, title: string, status: CardRow["status"], positionKey: string,
  current?: CardRow["now"], queuePositionKey: string | null = null): CardRow => ({
  ...reviewCard,
  id,
  number,
  folderId: "pas-folder",
  title,
  status,
  blockedKind: status === "blocked" ? "question" : null,
  blockedDetail: null,
  positionKey,
  queuePositionKey,
  assigneeSessionId: "pas-main",
  assigneeAgentId: "roselin_codex",
  assigneeKind: "session",
  nodeId: "eiaserinnys",
  now: current,
});

const cards: CardRow[] = [
  card("pas-371", 371, "안티그라비티 사용량 화면 조사와 시안", "running", "a", {
    text: "코드 감수에서 지적 두 건이 나와 로젤린이 고치는 중입니다",
    turn: "agent", ask: null, updatedAt: now, sessionId: "pas-main",
  }),
  card("pas-366", 366, "PAS 카드 목록 호버 툴팁", "running", "b", {
    text: "세라피엘 설계안을 받아 시안 장면을 정리했습니다",
    turn: "user", ask: "이 장면들로 시안을 만들까요?", updatedAt: now, sessionId: "pas-main",
  }),
  card("pas-298", 298, "백그라운드 태스크 알림이 도착하지 않는 잔여 원인 조사와 수정", "running", "g", {
    text: "Claude 러너가 정상 종료할 때 자식 프로세스가 함께 끝나 결과 회수가 끊기는 경로는 재현했습니다. 비정상 종료 경로는 아직 재현하지 못해 노드 세 곳의 로그 수집 범위를 넓히고, 재시작 직후 들어온 알림이 사라지는 사례를 함께 모으며 다시 시도하는 중입니다",
    turn: "user", ask: "재현이 안 되는 경로는 이번 카드에서 빼고 따로 열까요?", updatedAt: now, sessionId: "pas-main",
  }),
  card("pas-340", 340, "운영 env 검증값 갱신", "blocked", "a", {
    text: "노드 인증이 만료되어 재로그인을 기다립니다",
    turn: "outside", ask: null, updatedAt: now, sessionId: null,
  }),
  card("pas-380", 380, "소울앱 설정 화면의 안전 영역과 돌아가기 버튼 정리", "queued", "e", null, "a"),
  card("pas-377", 377, "주간 회고 카드", "queued", "f", null, "b"),
];

const timeline = {
  messages: [{
    id: 1,
    parent_event_id: null,
    event_type: "assistant_message",
    payload: {
      timestamp: 1,
      content: "오늘 확인할 내용을 정리했습니다. 필요한 카드의 현재 상태를 목록에서 확인할 수 있습니다.",
      tool_use_id: "pas-main-1",
      _final_for_live_stream: true,
    },
    created_at: now,
  }],
  next_cursor: null,
};

mockApi({
  "GET /api/persistent-sessions": {
    sessions: [persistentSession], total: 1,
    create_defaults: { node_id: "eiaserinnys", preferred_agent_id: "roselin_codex", settings, initial_instruction: "", unavailable_reason: null },
  },
  "GET /api/persistent-sessions/pas-main": { session: persistentSession },
  "GET /api/config/settings": { categories: [] },
  "GET /api/folders": { folders: [], sessions: {} },
  "GET /api/nodes": { nodes: [{
    nodeId: "eiaserinnys", host: "localhost", port: 3105, status: "connected", capabilities: {},
    connectedAt: Date.parse(now), sessionCount: 1,
  }] },
  "GET /api/cards": { cards },
  "GET /api/sessions": { sessions: [session], total: 1 },
  "GET /api/sessions/pas-main/timeline": timeline,
});

mockImages([{ pattern: /^\/api\/nodes\/eiaserinnys\/agents\/roselin_codex\/portrait$/, file: "system-portrait.png" }]);

function PersistentSessionMockup() {
  useEffect(() => {
    const openTaskList = () => {
      if (document.querySelector(".persistent-session-tasks")) return true;
      const button = document.querySelector<HTMLButtonElement>('button[aria-label="작업 목록"]');
      if (!button) return false;
      button.click();
      return true;
    };
    if (openTaskList()) return;
    const observer = new MutationObserver(() => {
      if (openTaskList()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return <DashboardInternalLinks><PersistentSessionScreen sessionId="pas-main"/></DashboardInternalLinks>;
}

mountMockup(<PersistentSessionMockup/>);
