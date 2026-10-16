import React, { useCallback, useEffect, useRef } from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ApiClient } from '../api/client';
import { ChatInputComposer, type AppendGeneratedTextResult, type ChatInputComposerHandle } from '../components/chat/ChatInputComposer';
import { useTokens } from '../theme';

const reviewApi = {
  uploadAttachment: async () => ({ path: '/component-review/chat-ui-attachment.png' }),
} as unknown as ApiClient;

export function ReviewChatUiComposer() {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const composerRef = useRef<ChatInputComposerHandle>(null);
  const params = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search);
  const presentation = params?.get('context') === 'pas' ? 'manuscript' : 'default';
  const sampleId = params?.get('run') ?? 'default';
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
          sessionStatus="completed"
          nodeId="public-node"
          backend="claude"
          api={reviewApi}
          detailedNetworkActive
          appForeground
          minimumBottomPadding={0}
          requestBottomFollow={() => {}}
          presentation={presentation}
          onComposerLayout={() => {}}
        />
      </View>
    </View>
  );
}
