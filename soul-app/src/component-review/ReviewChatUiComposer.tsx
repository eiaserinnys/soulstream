import React, { useCallback, useEffect, useRef } from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ApiClient } from '../api/client';
import { ApiHttpError } from '../api/clientCore';
import type { SessionEvent } from '../api/types';
import { ChatInputComposer, type AppendGeneratedTextResult, type ChatInputComposerHandle } from '../components/chat/ChatInputComposer';
import { ChatInputRequest } from '../components/chat/ChatInputRequest';
import { ChatToolApprovalRequest } from '../components/chat/ChatToolApprovalRequest';
import { useSettingsStore } from '../store/settingsStore';
import { useTokens } from '../theme';

const reviewApi = {
  uploadAttachment: async () => ({ path: '/component-review/chat-ui-attachment.png' }),
} as unknown as ApiClient;

/** 카드 #1316 검수용: 멈춤이 노드에서 거절된 상황을 그대로 재현한다. */
const interruptFailureApi = {
  ...reviewApi,
  interruptSession: async () => {
    throw new ApiHttpError(
      '[interruptSession] HTTP 409 Conflict',
      409,
      JSON.stringify({ error: { code: 'SESSION_NOT_RUNNING' } }),
    );
  },
} as unknown as ApiClient;

/** 카드 #1316 검수용: 노드에 닿지 못한 중단 실패(503)를 그대로 재현한다. */
const interruptUnreachableApi = {
  ...reviewApi,
  interruptSession: async () => {
    throw new ApiHttpError(
      '[interruptSession] HTTP 503 Service Unavailable',
      503,
      JSON.stringify({ error: { code: 'NODE_UNAVAILABLE' } }),
    );
  },
} as unknown as ApiClient;

const reviewApprovalEvent = {
  id: 'review-action-failure-approval',
  type: 'tool_approval_requested',
  data: {
    approval_id: 'review-action-failure-approval-1',
    tool_name: '파일 읽기',
    agent_name: '예시 에이전트',
  },
} as unknown as SessionEvent;

/** 카드 #1316 검수용: 이미 끝난 입력 요청(422)을 재현한다. */
const reviewInputRequestEvent = {
  id: 'review-action-failure-input-request',
  type: 'input_request',
  data: {
    request_id: 'review-action-failure-input-request-1',
    started_at: Date.now() / 1000,
    timeout_sec: 300,
    questions: [
      {
        question: '이미 끝난 입력 요청을 다시 보낼까요?',
        multiSelect: false,
        options: [
          { label: '보내기', description: '이미 끝난 요청의 응답을 다시 보냅니다.' },
        ],
      },
    ],
  },
} as unknown as SessionEvent;

export function ReviewChatUiComposer() {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const composerRef = useRef<ChatInputComposerHandle>(null);
  const params = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search);
  const presentation = params?.get('context') === 'pas' ? 'manuscript' : 'default';
  const sampleId = params?.get('run') ?? 'default';
  const failureSample = params?.get('failure') ?? null;
  const sessionId = `review-chat-ui-composer-${presentation}-${sampleId}`;
  const manuscript = presentation === 'manuscript';
  const backgroundColor = manuscript ? t.persistentSession.paper : t.colors.background;
  const interruptSample = failureSample === 'interrupt' || failureSample === 'interrupt-unreachable';

  const appendReviewText = useCallback((): AppendGeneratedTextResult | undefined => (
    composerRef.current?.appendGeneratedText(sessionId, '검수용으로 더한 글입니다. 확인한 뒤 직접 전송합니다.')
  ), [sessionId]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const reviewWindow = window as Window & {
      __appendReviewChatUiText?: typeof appendReviewText;
    };
    reviewWindow.__appendReviewChatUiText = appendReviewText;
    return () => { delete reviewWindow.__appendReviewChatUiText; };
  }, [appendReviewText]);

  // 설정 저장소의 비동기 리하이드레이션이 initializeReview의 serverUrl을 덮어써
  // 승인·입력 요청 표본이 서버로 요청을 보내지 못하던 문제를 막는다.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const pinServerUrl = () => {
      useSettingsStore.setState({ serverUrl: window.location.origin });
    };
    pinServerUrl();
    return useSettingsStore.persist.onFinishHydration(pinServerUrl);
  }, []);

  return (
    <View testID="review-chat-ui-composer" style={{ flex: 1, backgroundColor }}>
      <View style={{ flex: 1, minHeight: 0, paddingTop: insets.top }}>
        <View style={{ paddingHorizontal: t.foundation.pageInset }}>
          <Text accessibilityRole="header" style={{ ...t.foundation.typography.section, color: t.colors.textPrimary }}>
            {manuscript ? 'PAS' : '채팅'}
          </Text>
        </View>
      </View>
      <View style={{ paddingBottom: insets.bottom, marginHorizontal: manuscript ? t.foundation.pageInset : 0 }}>
        <ChatInputComposer
          ref={composerRef}
          sessionId={sessionId}
          sessionStatus={interruptSample ? 'running' : 'completed'}
          nodeId="public-node"
          backend="claude"
          api={
            failureSample === 'interrupt'
              ? interruptFailureApi
              : failureSample === 'interrupt-unreachable'
                ? interruptUnreachableApi
                : reviewApi
          }
          detailedNetworkActive
          appForeground
          minimumBottomPadding={0}
          requestBottomFollow={() => {}}
          presentation={presentation}
          onComposerLayout={() => {}}
        />
        {failureSample === 'approval' ? (
          <View testID="review-chat-ui-tool-approval" style={{ marginTop: t.spacing.sm }}>
            <ChatToolApprovalRequest event={reviewApprovalEvent} sessionId={sessionId} presentation={presentation} />
          </View>
        ) : null}
        {failureSample === 'input-request' ? (
          <View testID="review-chat-ui-input-request" style={{ marginTop: t.spacing.sm }}>
            <ChatInputRequest event={reviewInputRequestEvent} sessionId={sessionId} />
          </View>
        ) : null}
      </View>
    </View>
  );
}
