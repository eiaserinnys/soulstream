import React, { createContext, useContext } from 'react';
import type { AttachmentReadContext } from '../../../packages/wire-schema/src/attachments';
import type { AttachmentView } from '../lib/attachment-view';

/** `getMessageAttachmentSignals`가 메시지 이벤트에서 뽑은 첨부 신호. */
export interface MessageAttachmentLoaderSignals {
  ids: string[];
  paths: string[];
  hasSignal: boolean;
}

export interface MessageAttachmentLoaderInput {
  eventId: string;
  signals: MessageAttachmentLoaderSignals;
  readContext?: AttachmentReadContext;
  signal: AbortSignal;
}

/**
 * 첨부 투영을 대신 만드는 선택적 로더.
 *
 * 검수 표본이 이 문맥으로 번들 그림에서 만든 항목을 넘기면 실제 대화 화면은
 * 그대로 두고 표본만 서버 없이 미리보기를 그린다. 문맥이 없으면
 * `useMessageAttachments`는 기존 세션 투영 경로를 쓴다. 참조가 바뀌면 요청이
 * 다시 나가므로 호출자는 안정 참조로 넘긴다.
 */
export type MessageAttachmentLoader = (input: MessageAttachmentLoaderInput) => Promise<AttachmentView[]>;

const MessageAttachmentLoaderContext = createContext<MessageAttachmentLoader | null>(null);

export function MessageAttachmentLoaderProvider({ loader, children }: {
  loader: MessageAttachmentLoader;
  children: React.ReactNode;
}) {
  return <MessageAttachmentLoaderContext.Provider value={loader}>{children}</MessageAttachmentLoaderContext.Provider>;
}

export function useMessageAttachmentLoader(): MessageAttachmentLoader | null {
  return useContext(MessageAttachmentLoaderContext);
}
