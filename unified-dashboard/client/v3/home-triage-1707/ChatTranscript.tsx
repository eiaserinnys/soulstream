// 세션 기록. 운영 정본 ChatMessageItem 을 세션 범위 저장소와 함께 쓴다.
import { useMemo } from "react";
import {
  ChatStoreScopeProvider,
  createChatSessionStore,
  type ChatMessage,
  type SessionSummary,
} from "@seosoyoung/soul-ui";
import { ChatMessageItem } from "@seosoyoung/soul-ui/components/chat/ChatMessageItem";

import type { SessionMessage } from "./triage-data";

const BASE_TIME = Date.parse("2026-11-19T03:10:00Z");

function toChatMessage(message: SessionMessage, index: number): ChatMessage {
  return {
    id: message.id,
    role: message.role === "agent" ? "assistant" : "user",
    content: message.text,
    timestamp: BASE_TIME + index * 60_000,
    treeNodeId: message.id,
    treeNodeType: "text",
    eventId: 0,
  };
}

export function ChatTranscript({
  messages,
  session,
  testId,
}: {
  messages: readonly SessionMessage[];
  session: SessionSummary;
  testId?: string;
}) {
  const scope = useMemo(() => {
    const next = createChatSessionStore(session.agentSessionId);
    next.store.setState({ activeSessionSummary: session });
    return next;
  }, [
    session.agentSessionId,
    session.agentName,
    session.agentPortraitUrl,
    session.agentId,
    session.nodeId,
    session.status,
    session.eventCount,
  ]);

  return (
    <ChatStoreScopeProvider scope={scope}>
      <div className="v3-ht-messages" data-testid={testId}>
        {messages.map((message, index) => (
          <ChatMessageItem
            key={message.id}
            msg={toChatMessage(message, index)}
            sessionId={session.agentSessionId}
          />
        ))}
      </div>
    </ChatStoreScopeProvider>
  );
}
