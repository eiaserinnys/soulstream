"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { ChatAttachmentItem } from "../lib/chat-attachment-model";

export interface ChatAttachmentLoaderInput {
  sessionId: string;
  eventId: number;
  signal: AbortSignal;
}

/**
 * 첨부 투영을 대신 만드는 선택적 로더.
 *
 * 검수 표본이 이 문맥으로 번들 그림에서 만든 항목을 넘기면 실제 대화 화면은
 * 그대로 두고 표본만 서버 없이 미리보기를 그린다. 문맥이 없으면
 * `useChatAttachments`는 기존 로더(`loadChatAttachments` + `projectChatAttachmentItems`)를
 * 쓴다. 참조가 바뀌면 요청이 다시 나가므로 호출자는 안정 참조로 넘긴다.
 */
export type ChatAttachmentLoader = (input: ChatAttachmentLoaderInput) => Promise<ChatAttachmentItem[]>;

const ChatAttachmentLoaderContext = createContext<ChatAttachmentLoader | null>(null);

export function ChatAttachmentLoaderProvider({ loader, children }: {
  loader: ChatAttachmentLoader;
  children: ReactNode;
}) {
  return <ChatAttachmentLoaderContext.Provider value={loader}>{children}</ChatAttachmentLoaderContext.Provider>;
}

export function useChatAttachmentLoader(): ChatAttachmentLoader | null {
  return useContext(ChatAttachmentLoaderContext);
}
