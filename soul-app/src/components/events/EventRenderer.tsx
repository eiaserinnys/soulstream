import React from 'react';
import type { SessionEvent, Session } from '../../api/types';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { ThinkingEvent } from './ThinkingEvent';
import { SystemEvent } from './SystemEvent';
import { ChatInputRequest } from '../chat/ChatInputRequest';
import { ChatToolApprovalRequest } from '../chat/ChatToolApprovalRequest';
import type { MessageSelectionModel } from './message-selection-model';
import type { PendingOptimisticEvent } from '../../store/chatStore';

export type ChatMessageSession = Pick<Session,
  'agentSessionId' | 'nodeId' | 'agentName' | 'agentPortraitUrl' | 'displayName' | 'userName' | 'userPortraitUrl'>;

interface Props {
  event: SessionEvent;
  /** 채팅 route가 이미 보유한 정본 ID. 세션 메타 로딩 여부와 무관하게 액션에 사용한다. */
  sessionId: string;
  /** 현재 세션 메타 — AssistantMessage가 에이전트 아바타를 좌측에 그릴 때 사용. */
  session?: ChatMessageSession;
  selectionModel?: MessageSelectionModel | null;
  onSelectionDone?: () => void;
  onRetryPending?: (eventId: string) => void;
  onRestorePending?: (eventId: string) => void;
  presentation?: 'default' | 'manuscript';
}

export function EventRenderer({
  event,
  sessionId,
  session,
  selectionModel,
  onSelectionDone,
  onRetryPending,
  onRestorePending,
  presentation = 'default',
}: Props) {
  const pending = event as PendingOptimisticEvent;
  const pendingActions = pending.pendingStatus === 'failed'
    ? {
        onRetry: onRetryPending ? () => onRetryPending(event.id) : undefined,
        onRestore: onRestorePending ? () => onRestorePending(event.id) : undefined,
      }
    : {};
  switch (event.type) {
    case 'user_message':
      return (
        <UserMessage
          event={event}
          presentation={presentation}
          session={session}
          variant="normal"
          pendingStatus={pending.pendingStatus}
          failureReason={pending.failureReason}
          {...pendingActions}
          selectionModel={selectionModel}
          onSelectionDone={onSelectionDone}
        />
      );
    // intervention은 mid-session 사용자 발화. 일반 user_message와 시각적으로 구분하기 위해
    // 주황 버블 variant로 표시 (빌드 15 사용자 요청).
    // 서버가 보내는 SSE 타입은 'intervention_sent' (빌드 18: 빌드 17까지 'intervention'으로 잘못 매칭).
    case 'intervention_sent':
      return (
        <UserMessage
          event={event}
          presentation={presentation}
          session={session}
          variant="intervention"
          pendingStatus={pending.pendingStatus}
          failureReason={pending.failureReason}
          {...pendingActions}
          selectionModel={selectionModel}
          onSelectionDone={onSelectionDone}
        />
      );
    case 'assistant_message':
    case 'text_delta':
      return (
        <AssistantMessage
          event={event}
          presentation={presentation}
          session={session}
          selectionModel={selectionModel}
          onSelectionDone={onSelectionDone}
        />
      );
    case 'realtime_transcript': {
      const role = event.data?.role;
      if (role === 'user') {
        return (
          <UserMessage
            event={event}
            presentation={presentation}
            session={session}
            variant="normal"
            selectionModel={selectionModel}
            onSelectionDone={onSelectionDone}
          />
        );
      }
      return (
        <AssistantMessage
          event={event}
          presentation={presentation}
          session={session}
          selectionModel={selectionModel}
          onSelectionDone={onSelectionDone}
        />
      );
    }
    // F-G fallback: text_start·text_end는 server 엔진의 *상태 마커* (engine/types.py:88-114
    // TextDeltaEngineEvent.to_sse). payload에 text/content가 없어 historical(messages REST)
    // 응답에서 분리 반환되면 AssistantMessage extractText '' → null 반환으로 invisible
    // phantom cell이 된다.
    // 정본 처리는 groupChatEvents.ts가 List 진입 자체를 차단 — 본 case는 그 가드를
    // *우회하는 historical 직접 렌더 경로*나 ChatRenderItem.kind='event' 외 진입(현재 없음)에
    // 대한 fallback. tool_start/tool_result null 패턴과 대칭.
    case 'text_start':
    case 'text_end':
      return null;
    // tool_start / tool_result는 ChatScreen이 페어링하여 ToolEvent로 직접 렌더한다.
    // groupChatEvents가 tool_start를 kind='tool'로 흡수하고 orphan tool_result를 출력에서
    // 제외하므로 (F-F), kind='event' 경로에서 본 case는 도달 불가 — fallback null.
    case 'tool_start':
    case 'tool_result':
    case 'result':
      return null;
    case 'thinking_start':
    case 'thinking_delta':
    case 'thinking_end':
      return <ThinkingEvent event={event} presentation={presentation} />;
    case 'session_start':
      return null;
    case 'complete':
    case 'context_usage':
    case 'compact':
    case 'session_notification':
      return <SystemEvent event={event} {...(presentation === 'manuscript' ? { presentation } : {})} />;
    case 'input_request':
      return (
        <ChatInputRequest
          event={event}
          sessionId={sessionId}
        />
      );
    case 'tool_approval_requested':
      if (!session?.agentSessionId) return <SystemEvent event={event}
        {...(presentation === 'manuscript' ? { presentation } : {})} />;
      return (
        <ChatToolApprovalRequest
          event={event}
          sessionId={session.agentSessionId}
          {...(presentation === 'manuscript' ? { presentation } : {})}
        />
      );
    // expired/responded는 store에 append되어 ChatInputRequest selector가 참조. 렌더 불필요.
    case 'input_request_expired':
    case 'input_request_responded':
    case 'tool_approval_resolved':
      return null;
    // 오류·시스템 공지 같은 의미 있는 시스템 이벤트는 유지.
    case 'system':
    case 'realtime_status':
    case 'guardrail_tripwire':
    case 'error':
      return <SystemEvent event={event} {...(presentation === 'manuscript' ? { presentation } : {})} />;
    // history_sync는 SSE 연결 직후 baseline 메타 이벤트일 뿐 사용자 메시지가 아니다.
    case 'history_sync':
      return null;
    default:
      return null;
  }
}
