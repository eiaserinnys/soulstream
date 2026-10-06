import React, { useRef, useState } from 'react';
import { FlatList, ScrollView, Switch, Text, View, useWindowDimensions } from 'react-native';
import { useTokens } from '../theme';
import { ChatComposer } from '../components/chat/ChatComposer';
import { AttachmentChips } from '../components/chat/AttachmentChips';
import { ChatInterruptButton } from '../components/chat/ChatInterruptButton';
import { makeStyles } from '../components/chat/ChatBody.styles';
import { UserMessage } from '../components/events/UserMessage';
import { AssistantMessage } from '../components/events/AssistantMessage';
import { SystemEvent } from '../components/events/SystemEvent';
import { TurnSummaryCaption } from '../components/events/TurnSummaryCaption';
import { CollapsibleCaption, CollapsibleCaptionLine } from '../components/chat/CollapsibleCaption';
import { LabeledDivider } from '../components/chat/LabeledDivider';
import { AttachmentImage } from '../components/AttachmentImage';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';
import { GlassButton } from '../components/GlassSurface';
import { message, sessions } from './fixtures';
import { ReviewSection } from './ReviewSection';
import { formatAssignedCardContextSnapshot } from '../components/chat/turnSummaryProjection';
import { ChatEventList } from '../components/chat/ChatEventList';
import type { ChatRenderItem } from '../components/chat/groupChatEvents';
import { useChatRenderItems } from '../components/chat/useChatRenderItems';
import type { SessionEvent } from '../api/types';
import { useChatStore } from '../store/chatStore';
import { persistentJevCandidatesFixture } from './persistentJevCandidatesFixture';
import { EventRenderer } from '../components/events/EventRenderer';
import { ToolEvent } from '../components/events/ToolEvent';

const options = [
  { value: 'normal', label: '기본' }, { value: 'sending', label: '전송 중' },
  { value: 'uploading', label: '첨부 중' }, { value: 'interrupting', label: '정지 중' },
  { value: 'disabled', label: '비활성' },
] as const;
const assignedCardPreview = formatAssignedCardContextSnapshot({
  capturedAt: '2026-10-02T01:00:00.000Z',
  cards: [{
    id: '860fe149-ae89-46bd-bb3e-b6115229edba',
    title: '담당 카드 현황 매 턴 주입·외부 변경 알림',
    status: 'running',
    latestCommentAt: '2026-10-02T00:55:00.000Z',
    latestReportAt: '2026-10-02T00:40:00.000Z',
  }],
});

const persistentChatEvents: SessionEvent[] = [
  { id: '900', type: 'assistant_message', data: { text: '앞 답변입니다. 다음 세대를 준비합니다.' } },
  { id: '901', type: 'generation_started', data: { generation: 2 } },
  { id: '902', type: 'assistant_message', data: { text: '다음 세대의 첫 답변입니다.' } },
  { id: '903', type: 'complete', data: { result: '응답을 마쳤습니다.', model: 'public-model', usage: { input_tokens: 100, output_tokens: 20 } } },
  { id: '904', type: 'user_message', data: { input_id: 'public-input-1', text: '관련 자료를 찾아줘.' } },
  persistentJevCandidatesFixture('905', 'public-input-1'),
  { id: '906', type: 'user_message', data: { input_id: 'public-input-2', text: '비슷한 기록이 있는지 확인해줘.' } },
  persistentJevCandidatesFixture('907', 'public-input-2', { selectedCount: 0 }),
  { id: '908', type: 'user_message', data: { input_id: 'public-input-3', text: '긴 후보 요약이 입력 말풍선 아래에서 어떻게 보이는지 확인해줘.' } },
  persistentJevCandidatesFixture('909', 'public-input-3', { selectedCount: 1, longLine: true }),
  { id: '910', type: 'user_message', data: { input_id: 'public-input-4', text: 'Jev 후보와 담당 카드 기록의 순서를 확인해줘.' } },
  {
    id: '911',
    type: 'debug',
    data: {
      kind: 'assigned_card_context_snapshot',
      content: '담당 카드 입력 준비',
      capture: {
        source: 'prepared_model_input',
        identityMissing: false,
        registrationId: 'review-registration',
        executionCommandId: 'review-command',
        inputId: 'public-input-4',
        snapshot: {
          capturedAt: '2026-10-02T01:00:00.000Z',
          cards: [{ title: 'PAS 후보와 담당 카드 기록 함께 표시', status: 'running', latestReportAt: null }],
        },
      },
    },
  },
  persistentJevCandidatesFixture('912', 'public-input-4', { selectedCount: 1 }),
];

function ReviewPersistentChatProjection() {
  const t = useTokens();
  const styles = makeStyles(t);
  const flatListRef = useRef<FlatList<ChatRenderItem>>(null);
  const settings = useChatStore(state => {
    const current = state.persistentDisplaySettings;
    return current?.sessionId === 'review-pas-1' ? current.settings : null;
  });
  const showGenerationSeparator = settings?.show_generation_separator === true;
  const showJevCandidates = settings?.show_jev_candidates === true;
  const updateDisplaySetting = (key: 'show_generation_separator' | 'show_jev_candidates', value: boolean) => {
    const current = useChatStore.getState().persistentDisplaySettings;
    if (current?.sessionId !== 'review-pas-1' || !current.settings) return;
    useChatStore.getState().applyPersistentDisplaySettings('review-pas-1', { ...current.settings, [key]: value });
  };
  const { reversedItems } = useChatRenderItems({
    events: persistentChatEvents,
    pendingOptimistic: undefined,
    streamingSlots: undefined,
    sessionStatus: 'completed',
    persistentDisplaySettings: settings ? {
      showGenerationSeparator: settings.show_generation_separator,
      showJevCandidates: settings.show_jev_candidates,
    } : undefined,
  });
  return <View testID="review-persistent-chat-projection" style={styles.container}>
    <View>
      <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>세대 구분선 표시</Text>
      <Switch accessibilityLabel="검수 창 세대 구분선 표시" testID="review-persistent-generation-toggle" value={showGenerationSeparator} onValueChange={value => updateDisplaySetting('show_generation_separator', value)} />
      <Text style={{ ...t.foundation.typography.body, color: t.colors.textSecondary }}>Jev 후보 표시</Text>
      <Switch accessibilityLabel="검수 창 Jev 후보 표시" testID="review-persistent-jev-toggle" value={showJevCandidates} onValueChange={value => updateDisplaySetting('show_jev_candidates', value)} />
    </View>
    <ChatEventList
      flatListRef={flatListRef}
      items={reversedItems}
      session={undefined}
      sessionId="review-pas-1"
      api={null}
      styles={styles}
      accentColor={t.colors.accent}
      requestOlder={() => {}}
      onScroll={() => {}}
      onScrollBeginDrag={() => {}}
      historyLoading={false}
      reachedTop
      hasFetchError={false}
      retryFromError={() => {}}
      mvcpEnabled={false}
      onContentSizeChange={() => {}}
    />
  </View>;
}

export function ReviewChat() {
  const t = useTokens();
  const { width } = useWindowDimensions();
  const styles = makeStyles(t);
  const [input, setInput] = useState('');
  const [sent, setSent] = useState('');
  const [state, setState] = useState<typeof options[number]['value']>('normal');
  const [selection, setSelection] = useState(false);
  const [failure, setFailure] = useState(true);
  const [attachment, setAttachment] = useState(false);
  const markdown = '**공개 예시 답변**\n\n> 핵심 내용을 인용문으로 표시합니다.\n\n- 본문 크기와 줄 간격\n- `코드`와 **강조**\n\n[공개 문서](https://expo.dev)';
  const finalReply = '조사 결과를 확인했습니다. 다음 단계에서 수정 내용을 검증하겠습니다.';
  return <>
    <ReviewSection title="영구 세션 표시 · raw timeline/SSE → 묶기 → 채팅 목록">
      <ReviewPersistentChatProjection />
    </ReviewSection>
    <ReviewSection title="입력창 · 빈 입력·여러 줄·전송·첨부·정지·비활성">
      <SettingsSegmentedControl<typeof options[number]['value']> id="review-composer-state" value={state} onChange={setState} options={options} />
      <ChatComposer input={state === 'sending' ? '' : input} onChangeInput={setInput} onSend={() => { setSent(input); setInput(''); }}
        onPickAttachment={() => setAttachment(true)} uploading={state === 'uploading'}
        sending={state === 'sending'} disabled={state === 'disabled'} voiceControls={null}
        interruptControls={state === 'interrupting' ? <ChatInterruptButton
          interrupting={state === 'interrupting'} styles={styles} accentTextColor={t.colors.accentText} disabled
          onPress={() => {}}
        /> : null}
        inputAccessibilityLabel="공개 예시 메시지" />
      {attachment ? <AttachmentImage source={require('../../assets/icon.png')} accessibilityLabel="공개 예시 첨부 열기" /> : null}
      {sent ? <UserMessage event={message('user_message', sent)} /> : null}
    </ReviewSection>
    <ReviewSection title="입력창 · embedded · 프레임이 바깥 여백 소유">
      <View style={{ padding: t.uiSpacing.md }}>
        <ChatComposer embedded input={state === 'sending' ? '' : input} onChangeInput={setInput} onSend={() => { setSent(input); setInput(''); }}
          onPickAttachment={() => setAttachment(true)} uploading={state === 'uploading'}
          sending={state === 'sending'} disabled={state === 'disabled'} voiceControls={null}
          inputAccessibilityLabel="embedded 예시 메시지" />
      </View>
    </ReviewSection>
    <ReviewSection title="사용자 말풍선 · 일반·개입·전송 실패">
      <UserMessage event={message('user_message', '이 프로젝트의 화면을 검수해주세요. 긴 문장과 여러 줄을 확인합니다.')} />
      <UserMessage variant="intervention" event={message('intervention_sent', '추가 지시를 보내는 공개 예시입니다.')} />
      {failure ? <UserMessage event={message('user_message', '다시 보낼 공개 예시 메시지')}
        pendingStatus="failed" failureReason="공개 예시: 전송하지 못했습니다."
        onRetry={() => setFailure(false)} onRestore={() => { setInput('다시 보낼 공개 예시 메시지'); setFailure(false); }} /> : null}
    </ReviewSection>
    <ReviewSection title="에이전트 말풍선 · Markdown·스트리밍·텍스트 선택">
      <GlassButton onPress={() => setSelection((value) => !value)} accessibilityLabel="답변 텍스트 선택">
        <Text style={{ ...t.foundation.typography.body, color: t.colors.textPrimary }}>답변 텍스트 선택</Text>
      </GlassButton>
      <AssistantMessage session={sessions[0]} event={message('assistant_message', markdown)}
        selectionModel={selection ? { kind: 'markdown', text: markdown } : null} onSelectionDone={() => setSelection(false)} />
      <AssistantMessage session={sessions[0]} event={message('text_delta', '응답을 작성하고 있습니다…')} />
    </ReviewSection>
    <ReviewSection title="안내문 · 완료·실패·하위 보고">
      <AssistantMessage session={sessions[0]} event={message('assistant_message', finalReply)} />
      <SystemEvent event={{ id: 'public-context-usage', type: 'context_usage', data: {
        used_tokens: 326300, max_tokens: 1000000, percent: 32.6,
      } }} />
      <SystemEvent event={{ id: 'public-context-usage-estimated', type: 'context_usage', data: {
        used_tokens: 14223, max_tokens: 1000000, percent: 1.4, estimated: true,
      } }} />
      <SystemEvent event={{ id: 'public-complete', type: 'complete', data: { result: finalReply } }} />
      <SystemEvent event={{ id: 'public-complete-usage', type: 'complete', data: {
        result: finalReply,
        model: 'claude-fable-5-1',
        usage: {
          input_tokens: 6, output_tokens: 6139,
          cache_read_input_tokens: 637594, cache_creation_input_tokens: 7767,
        },
        total_cost_usd: 17.91, turn_cost_usd: 0.621749, session_cost_usd: 17.91,
      } }} />
      <SystemEvent event={{ id: 'public-complete-codex', type: 'complete', data: {
        result: finalReply,
        model: 'gpt-6.1-sol',
        usage: { input_tokens: 14124, cached_input_tokens: 12288, output_tokens: 5, reasoning_output_tokens: 0 },
        turn_cost_usd: 0.004951, session_cost_usd: 0.004951,
      } }} />
      <SystemEvent event={{ id: 'public-complete-partial', type: 'complete', data: {
        result: finalReply,
        model: 'claude-fable-5-1',
        usage: {
          input_tokens: 6, output_tokens: 6139,
          cache_read_input_tokens: 637594, cache_creation_input_tokens: 7767,
        },
        turn_cost_usd: 0.621749, session_cost_usd: 3.2, session_cost_partial: true,
      } }} />
      <SystemEvent event={{ id: 'public-complete-no-price', type: 'complete', data: {
        result: finalReply,
        model: 'gpt-6-luna',
        usage: { input_tokens: 14124, cached_input_tokens: 12288, output_tokens: 5 },
      } }} />
      <CollapsibleCaption title="Jev 후보 3">
        <CollapsibleCaptionLine>T38 · 요약 한 줄 · 3/3</CollapsibleCaptionLine>
        <CollapsibleCaptionLine>#412 · 카드 한 줄 · 2/3</CollapsibleCaptionLine>
        <CollapsibleCaptionLine>세션 제목 · 한 줄 · 2/3</CollapsibleCaptionLine>
      </CollapsibleCaption>
      <CollapsibleCaption title="Jev 후보 3 · 오른쪽 정렬" align="end">
        <CollapsibleCaptionLine>T38 · 요약 한 줄 · 3/3</CollapsibleCaptionLine>
        <CollapsibleCaptionLine>#412 · 카드 한 줄 · 2/3</CollapsibleCaptionLine>
      </CollapsibleCaption>
      <CollapsibleCaption title="Jev 후보 1 · 오른쪽 정렬 펼침" align="end" initiallyCollapsed={false}>
        <CollapsibleCaptionLine>T38 · 요약 한 줄 · 3/3</CollapsibleCaptionLine>
      </CollapsibleCaption>
      <CollapsibleCaption title="Jev 후보 1 · 오른쪽 정렬 긴 줄" align="end" initiallyCollapsed={false}>
        <CollapsibleCaptionLine>이 후보의 긴 요약은 좁은 화면에서 한 줄 말줄임 처리가 실제 캡션에 적용되는지 확인하기 위한 문장입니다</CollapsibleCaptionLine>
      </CollapsibleCaption>
      <CollapsibleCaption title="처음부터 펼친 예시" initiallyCollapsed={false}>
        <CollapsibleCaptionLine>T38 · 요약 한 줄 · 3/3</CollapsibleCaptionLine>
      </CollapsibleCaption>
      <CollapsibleCaption title="Jev 후보 0">
        <CollapsibleCaptionLine>2점 이상인 후보가 없습니다.</CollapsibleCaptionLine>
      </CollapsibleCaption>
      <CollapsibleCaption title="아주 긴 제목은 한 줄을 유지하며 끝에서 말줄임합니다">
        <CollapsibleCaptionLine>
          아주 긴 내용 줄도 글자 수로 자르지 않고 화면 폭에 맞춰 끝에서 말줄임합니다.
        </CollapsibleCaptionLine>
      </CollapsibleCaption>
      <AssistantMessage session={sessions[0]} event={message('assistant_message', '앞 답변입니다. 다음 세대를 준비합니다.')} />
      <LabeledDivider label="새 세대" />
      <AssistantMessage session={sessions[0]} event={message('assistant_message', '다음 세대의 첫 답변입니다.')} />
      <LabeledDivider label="응답 교체" />
      <AssistantMessage session={sessions[0]} event={message('assistant_message', '교체된 답변 뒤에도 간격이 이어집니다.')} />
      <LabeledDivider label="이 라벨은 길이가 달라져도 두 선의 가운데를 확인합니다" />
      <AssistantMessage session={sessions[0]} event={message('assistant_message', '긴 라벨 다음의 답변입니다.')} />
      <SystemEvent event={{ id: 'public-error', type: 'error', data: {
        message: '응답 연결이 끊겼습니다. 현재 작업의 오류 내용을 확인해주세요.\n조사한 내용과 남은 작업을 확인할 수 있도록 긴 오류 문구를 표시합니다.',
      } }} />
      <SystemEvent event={{ id: 'public-notification', type: 'session_notification', data: {
        text: '하위 세션에서 조사 결과를 전달했습니다. 확인한 내용과 남은 작업을 함께 보고합니다.\n긴 보고 문구도 같은 안내문 안에서 읽을 수 있습니다.',
      } }} />
    </ReviewSection>
    <ReviewSection title="기존 caption · 기존 요약">
      <UserMessage event={message('user_message', '외부 카드 알림을 확인해줘')} />
      <TurnSummaryCaption content={assignedCardPreview} />
      <AssistantMessage session={sessions[0]} event={message('assistant_message', '구현을 맡겼습니다. 다른 작업 결과를 기다립니다.')} />
      <TurnSummaryCaption content="기존 요약: 다른 작업 결과를 기다립니다." />
    </ReviewSection>
    <ReviewSection title="기본 채팅 / 원고형 · 같은 메시지와 첨부·승인·도구">
      <ScrollView testID="manuscript-presentation-scroll" horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ flexDirection: 'row', gap: t.spacing.lg }}>
          <ReviewMessagePresentation title="기본" presentation="default" width={width >= 768 ? 480 : Math.min(width, 360)} />
          <ReviewMessagePresentation title="원고형" presentation="manuscript" width={width >= 768 ? 480 : Math.min(width, 360)} />
        </View>
      </ScrollView>
    </ReviewSection>
  </>;
}

function ReviewMessagePresentation({
  title,
  presentation,
  width,
}: {
  title: string;
  presentation: 'default' | 'manuscript';
  width: number;
}) {
  const t = useTokens();
  const styles = makeStyles(t);
  const markdown = '**검수용 답변**\n\n긴 한글 문단으로 본문 폭과 행간, Markdown 링크 [도움말](https://expo.dev), 글자 선택을 확인합니다.\n\n- 도구와 시스템 행 유지\n- 답변 본문은 기존 채팅을 사용';
  const presentationSession = { ...sessions[0], agentSessionId: 'review-presentation-session' };
  const approval = { id: 'review-approval', type: 'tool_approval_requested' as const, data: {
    approval_id: 'review-approval-1', tool_name: '파일 읽기', agent_name: '예시 에이전트',
  } };
  const imageMessage = message('user_message', '첨부 이미지를 눌러 확대할 수 있습니다.') as SessionEvent;
  imageMessage.data = { ...imageMessage.data, attachments: ['/review/one.png'], node_id: 'public-node' };

  return (
    <View style={{ width, paddingHorizontal: presentation === 'manuscript' && width >= 480 ? 0 : presentation === 'manuscript' ? t.spacing.xl : t.spacing.md,
      backgroundColor: presentation === 'manuscript' ? t.persistentSession.paper : t.colors.background }}>
      <View testID={`manuscript-presentation-column-${presentation}`} style={{ width: width - 2 * (presentation === 'manuscript' && width >= 480 ? 0 : presentation === 'manuscript' ? t.spacing.xl : t.spacing.md), gap: t.spacing.md }}>
        <Text style={{ ...t.foundation.typography.section, color: t.colors.textPrimary }}>{title}</Text>
        <UserMessage presentation={presentation} event={message('user_message', '긴 요청 문단입니다. 조사한 결과와 다음 행동을 알려주세요.')} />
        <UserMessage presentation={presentation} variant="intervention" event={message('intervention_sent', '실행 중 추가한 개입 발언입니다.')} />
        <UserMessage presentation={presentation} event={imageMessage} session={{ ...presentationSession, nodeId: 'public-node' }} />
        <AttachmentImage source={require('../../assets/icon.png')} accessibilityLabel="공개 이미지 첨부 열기" />
        <AssistantMessage presentation={presentation} session={presentationSession} event={message('assistant_message', markdown)} />
        <AssistantMessage presentation={presentation} session={presentationSession} event={message('text_delta', '지금 응답을 작성하고 있습니다…')} />
        <EventRenderer presentation={presentation} event={approval} session={presentationSession} sessionId={presentationSession.agentSessionId} />
        <ToolEvent presentation={presentation} start={message('tool_start', '')} result={message('tool_result', '')} sessionId={presentationSession.agentSessionId} />
        <SystemEvent event={{ id: 'review-shape-error', type: 'error', data: { message: '도구 요청에서 발생한 오류입니다. 재시도할 수 있습니다.' } }} />
        <CollapsibleCaption title="Jev 후보 2 · 본문 시작선" align="end" alignmentInset={presentation === 'manuscript' ? 'content' : 'avatar'}>
          <CollapsibleCaptionLine>요약 · 일치도 3/3</CollapsibleCaptionLine>
          <CollapsibleCaptionLine>카드 · 일치도 2/3</CollapsibleCaptionLine>
        </CollapsibleCaption>
        <TurnSummaryCaption content={assignedCardPreview} presentation={presentation} />
        <LabeledDivider label="새 세대" alignmentInset={presentation === 'manuscript' ? 'content' : 'avatar'} />
        <AttachmentChips
          attachments={[{ path: '/review/waiting.png', name: '대기 첨부.png' }]}
          styles={styles}
          textSecondaryColor={t.colors.textSecondary}
          textMutedColor={t.colors.textMuted}
          onRemove={() => {}}
        />
        <ChatComposer presentation={presentation} input="한 줄 입력" onChangeInput={() => {}} onSend={() => {}}
          onPickAttachment={() => {}} uploading={false} sending={false} voiceControls={null} />
        <ChatComposer presentation={presentation} input={'여러 줄로 자라는 입력\n두 번째 줄도 확인합니다'} onChangeInput={() => {}} onSend={() => {}}
          onPickAttachment={() => {}} uploading={false} sending={false} voiceControls={null} />
        <Text style={{ ...t.foundation.typography.meta, color: t.colors.textMuted }}>입력창의 줄 높이와 대기 첨부를 비교합니다.</Text>
      </View>
    </View>
  );
}
