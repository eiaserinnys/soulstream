import "../client/globals.css";

import { createRoot } from "react-dom/client";

import { AskQuestionBanner } from "../../packages/soul-ui/src/components/AskQuestionBanner";
import { ChatInputRequest } from "../../packages/soul-ui/src/components/chat/ChatInputRequest";
import type { ChatMessage } from "../../packages/soul-ui/src/lib/flatten-tree";
import { useDashboardStore } from "../../packages/soul-ui/src/stores/dashboard-store";

const questions = [{
  header: "수정 범위",
  question: "수정 범위를 어디까지 가져갈까요?",
  options: [
    {
      label: "전체 묶음 (권장)",
      description: "주변 카탈로그 스냅샷과 후속 메모리 처리까지 한 사이클로 검증합니다.",
    },
    {
      label: "주변만 먼저",
      description: "변경 표면이 작은 경로부터 확인하고 나머지는 후속으로 분리합니다.",
    },
    {
      label: "주변 + 계속",
      description: "인접 흐름을 먼저 정리한 뒤 같은 배포 묶음으로 계속 진행합니다.",
    },
  ],
}];

const inputRequestNode = {
  id: "input-request-qa",
  type: "input_request" as const,
  content: questions[0]!.question,
  completed: false,
  children: [],
  requestId: "qa-input-row",
  toolUseId: "qa-ask-user-question",
  responded: false,
  expired: false,
  receivedAt: Date.now(),
  timeoutSec: 300,
  questions,
};

useDashboardStore.setState((state) => ({
  activeSessionKey: "qa-session",
  tree: {
    id: "session-root-qa",
    type: "session",
    sessionId: "qa-session",
    content: "",
    completed: false,
    children: [inputRequestNode],
  },
  treeVersion: state.treeVersion + 1,
}));

const chatMessage = {
  id: inputRequestNode.id,
  type: "input_request",
  role: "input_request",
  content: inputRequestNode.content,
  treeNodeId: inputRequestNode.id,
  requestId: inputRequestNode.requestId,
  receivedAt: inputRequestNode.receivedAt,
  timeoutSec: inputRequestNode.timeoutSec,
  responded: false,
  expired: false,
  questions,
} as ChatMessage;

function Fixture() {
  const surface = new URLSearchParams(window.location.search).get("surface");
  if (surface === "chat") {
    return (
      <main className="min-h-screen bg-background p-3 text-foreground">
        <div className="mx-auto w-full max-w-[560px]">
          <ChatInputRequest msg={chatMessage} sessionId="qa-session" />
        </div>
      </main>
    );
  }
  return (
    <main className="min-h-screen bg-background text-foreground">
      <AskQuestionBanner />
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
createRoot(root).render(<Fixture />);
