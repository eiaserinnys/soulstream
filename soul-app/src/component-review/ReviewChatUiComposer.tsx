import React, { useCallback, useEffect, useRef } from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ApiClient } from '../api/client';
import { ApiHttpError } from '../api/clientCore';
import type { SessionEvent } from '../api/types';
import { ChatInputComposer, type AppendGeneratedTextResult, type ChatInputComposerHandle } from '../components/chat/ChatInputComposer';
import { ChatToolApprovalRequest } from '../components/chat/ChatToolApprovalRequest';
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

const reviewApprovalEvent = {
  id: 'review-action-failure-approval',
  type: 'tool_approval_requested',
  data: {
    approval_id: 'review-action-failure-approval-1',
    tool_name: '파일 읽기',
    agent_name: '예시 에이전트',
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
          sessionStatus={failureSample === 'interrupt' ? 'running' : 'completed'}
          nodeId="public-node"
          backend="claude"
          api={failureSample === 'interrupt' ? interruptFailureApi : reviewApi}
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
      </View>
    </View>
  );
}
