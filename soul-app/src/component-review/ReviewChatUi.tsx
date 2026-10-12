import React, { useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { validateChatUiDocument } from '@soulstream/chat-ui';
import { useTokens } from '../theme';
import { ChatUiControllerProvider, type AppendGeneratedText } from '../components/chat-ui/ChatUiControllerProvider';
import { ChatUiMessage, ChatUiRenderFallback } from '../components/chat-ui/ChatUiMessage';
import { ChatUiErrorBoundary } from '../components/chat-ui/ChatUiErrorBoundary';
import { ChatUiLinkFocusScope } from '../components/chat-ui/ChatUiLinkFocusScope';
import { ChatUiNotice } from '../components/chat-ui/ChatUiNotice';
import { GlassButton } from '../components/GlassSurface';
import { ChatComposer } from '../components/chat/ChatComposer';
import { getChatRowHorizontalInset } from '../components/chat/ChatBody.styles';
import { AssistantMessage } from '../components/events/AssistantMessage';
import { UserMessage } from '../components/events/UserMessage';
import { chatUiFixtureEvent, chatUiCoverageDocument, type ChatUiExample } from './chat-ui-fixtures';

/** P4 mounts the real message surface, with an explicit trial append bridge.
 * P5 will connect the actual event list, transport, menu and composer handle. */
export function ReviewChatUi() {
  const t = useTokens();
  const params = useMemo(() => typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams(), []);
  const example: ChatUiExample = params.get('example') === 'pas' ? 'pas' : params.get('example') === 'gallery' ? 'gallery' : 'normal';
  const presentation = params.get('presentation') === 'manuscript' ? 'manuscript' : 'default';
  const state = params.get('state');
  const sessionId = 'chat-ui-review-session';
  const [shown, setShown] = useState(true);
  const [draft, setDraft] = useState('기존 초안');
  const event = useMemo(() => {
    const event = chatUiFixtureEvent(example, params.get('sample') === 'coverage' ? { document: chatUiCoverageDocument } : {});
    if (state === 'unsupported') return chatUiFixtureEvent(example, { schema_version: 2 });
    if (state === 'invalid') return chatUiFixtureEvent(example, { document: { schema_version: 2, body: [] } });
    if (state === 'missing') return chatUiFixtureEvent(example, { document: undefined });
    if (state === 'absent') return { ...event, data: { content: '저장된 일반 답변이야. [Renderer 문서](https://www.openui.com/docs/openui-lang/renderer)' } };
    return event;
  }, [example, params, state]);
  const parsed = useMemo(() => validateChatUiDocument(event.data.document ?? (event.data.ui as { document?: unknown })?.document), [event]);
  const appendGeneratedText: AppendGeneratedText = (targetSessionId, text) => {
    if (targetSessionId !== sessionId) return { ok: false, reason: 'wrong_session' };
    if (params.get('append') === 'too_long') return { ok: false, reason: 'too_long' };
    if (params.get('append') === 'disabled') return { ok: false, reason: 'disabled' };
    setDraft(current => current + (current && text ? '\n\n' : '') + text);
    return { ok: true };
  };
  const body = { fontSize: t.chatFontSize.body, lineHeight: t.chatFontSize.body * t.lineHeightRatio, color: t.colors.textPrimary };
  const meta = { fontSize: t.chatFontSize.meta, lineHeight: t.chatFontSize.meta * t.lineHeightRatio, color: t.colors.textSecondary };
  const session = { agentName: 'Assistant', displayName: 'Assistant' };
  return <SafeAreaView testID="chat-ui-renderer-review" style={{ flex: 1, minHeight: 0,
    backgroundColor: presentation === 'manuscript' ? t.persistentSession.paper : t.colors.background }}>
    <ChatUiControllerProvider sessionId={sessionId} appendGeneratedText={appendGeneratedText}>
      <View style={{ paddingHorizontal: t.foundation.pageInset, paddingVertical: t.spacing.sm, flexDirection: 'row',
        alignItems: 'center', justifyContent: 'space-between', gap: t.spacing.sm }}>
        <Text style={body}>{presentation === 'manuscript' ? 'PAS' : '채팅'} <Text style={meta}>검수</Text></Text>
        {params.get('sample') === 'remount' && <GlassButton size="compact" variant={presentation === 'manuscript' ? 'paper' : 'secondary'}
          onPress={() => setShown(value => !value)} accessibilityLabel={shown ? '응답 숨기기' : '응답 다시 붙이기'}><Text style={body}>{shown ? '숨기기' : '다시 붙이기'}</Text></GlassButton>}
      </View>
      <View style={{ flex: 1, minHeight: 0, marginHorizontal: presentation === 'manuscript' ? t.foundation.pageInset : 0 }}>
        <ScrollView testID="chat-ui-review-messages" style={{ flex: 1 }} showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingVertical: t.spacing.md, gap: t.spacing.lg }}>
          <UserMessage event={{ id: 'chat-ui-review-prompt', type: 'user_message', data: { text:
            example === 'pas' ? '검수 뒤에는 무엇부터 진행할까?' : example === 'normal' ? '인원수와 결제 조건을 바꾸며 팀 요금을 비교해 줘.' : '첫 조각 구성 요소와 모든 입력 종류를 보여줘.' } }} presentation={presentation} />
          {params.get('sample') === 'row-inset' && <AssistantMessage session={session} presentation={presentation}
            event={{ id: 'chat-ui-review-long-plain', type: 'assistant_message', data: { content: '같은 화면의 일반 글과 구조화 응답의 초상과 말풍선 양 끝을 비교해. '.repeat(8) } }} />}
          {shown && (state === 'render-error' && parsed.ok
            ? <ChatUiLinkFocusScope><ChatUiErrorBoundary fallback={<ChatUiRenderFallback event={event} session={session} presentation={presentation} document={parsed.document} />}>
                <ReviewRenderFailure />
              </ChatUiErrorBoundary></ChatUiLinkFocusScope>
            : <ChatUiMessage event={event} session={session} presentation={presentation} />)}
        </ScrollView>
        <View testID="chat-ui-review-bridge" style={{ paddingHorizontal: getChatRowHorizontalInset(t, presentation) }}><ChatUiNotice /></View>
        <ChatComposer input={draft} onChangeInput={setDraft} onSend={() => {}} onPickAttachment={() => {}}
          uploading={false} sending={false} voiceControls={null} presentation={presentation} inputAccessibilityLabel="시험용 채팅 초안" />
      </View>
    </ChatUiControllerProvider>
  </SafeAreaView>;
}
function ReviewRenderFailure(): React.ReactNode { throw Error('검수용 렌더 오류'); }
