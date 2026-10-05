import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { useTokens } from '../theme';
import { ChatComposer } from '../components/chat/ChatComposer';
import { ChatInterruptButton } from '../components/chat/ChatInterruptButton';
import { makeStyles } from '../components/chat/ChatBody.styles';
import { UserMessage } from '../components/events/UserMessage';
import { AssistantMessage } from '../components/events/AssistantMessage';
import { SystemEvent } from '../components/events/SystemEvent';
import { TurnSummaryCaption } from '../components/events/TurnSummaryCaption';
import { AttachmentImage } from '../components/AttachmentImage';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';
import { GlassButton } from '../components/GlassSurface';
import { message, sessions } from './fixtures';
import { ReviewSection } from './ReviewSection';
import { formatAssignedCardContextSnapshot } from '../components/chat/turnSummaryProjection';

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
export function ReviewChat() {
  const t = useTokens();
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
      <SystemEvent event={{ id: 'public-error', type: 'error', data: {
        message: '응답 연결이 끊겼습니다. 현재 작업의 오류 내용을 확인해주세요.\n조사한 내용과 남은 작업을 확인할 수 있도록 긴 오류 문구를 표시합니다.',
      } }} />
      <SystemEvent event={{ id: 'public-notification', type: 'session_notification', data: {
        text: '하위 세션에서 조사 결과를 전달했습니다. 확인한 내용과 남은 작업을 함께 보고합니다.\n긴 보고 문구도 같은 안내문 안에서 읽을 수 있습니다.',
      } }} />
    </ReviewSection>
    <ReviewSection title="기존 caption · 기존 요약과 요청한 Jev 판정 한 줄">
      <UserMessage event={message('user_message', '외부 카드 알림을 확인해줘')} />
      <TurnSummaryCaption content={assignedCardPreview} />
      <AssistantMessage session={sessions[0]} event={message('assistant_message', '구현을 맡겼습니다. 다른 작업 결과를 기다립니다.')} />
      <TurnSummaryCaption content="기존 요약: 다른 작업 결과를 기다립니다." />
      <TurnSummaryCaption content="Jev · 위임 대기 — 다른 작업 결과를 기다리는 상태로 분류" />
      <TurnSummaryCaption content="Jev · 완료 가능 · 관측 범위 제한" />
      <TurnSummaryCaption content="Jev · 미평가 — 평가 요청 실패" />
    </ReviewSection>
  </>;
}
