import React, { useState } from 'react';
import { Text } from 'react-native';
import { useTokens } from '../theme';
import { ChatComposer } from '../components/chat/ChatComposer';
import { UserMessage } from '../components/events/UserMessage';
import { AssistantMessage } from '../components/events/AssistantMessage';
import { AttachmentImage } from '../components/AttachmentImage';
import { SettingsSegmentedControl } from '../components/settings/SettingsSegmentedControl';
import { GlassButton } from '../components/GlassSurface';
import { message, sessions } from './fixtures';
import { ReviewSection } from './ReviewSection';

const options = [
  { value: 'normal', label: '기본' }, { value: 'sending', label: '전송 중' },
  { value: 'uploading', label: '첨부 중' }, { value: 'disabled', label: '비활성' },
] as const;
export function ReviewChat() {
  const t = useTokens();
  const [input, setInput] = useState('');
  const [sent, setSent] = useState('');
  const [state, setState] = useState<typeof options[number]['value']>('normal');
  const [selection, setSelection] = useState(false);
  const [failure, setFailure] = useState(true);
  const [attachment, setAttachment] = useState(false);
  const markdown = '**공개 예시 답변**\n\n> 핵심 내용을 인용문으로 표시합니다.\n\n- 본문 크기와 줄 간격\n- `코드`와 **강조**\n\n[공개 문서](https://expo.dev)';
  return <>
    <ReviewSection title="입력창 · 빈 입력·여러 줄·전송·첨부·비활성">
      <SettingsSegmentedControl<typeof options[number]['value']> id="review-composer-state" value={state} onChange={setState} options={options} />
      <ChatComposer input={input} onChangeInput={setInput} onSend={() => { setSent(input); setInput(''); }}
        onPickAttachment={() => setAttachment(true)} uploading={state === 'uploading'}
        sending={state === 'sending'} disabled={state === 'disabled'} voiceControls={null}
        inputAccessibilityLabel="공개 예시 메시지" />
      {attachment ? <AttachmentImage source={require('../../assets/icon.png')} accessibilityLabel="공개 예시 첨부 열기" /> : null}
      {sent ? <UserMessage event={message('user_message', sent)} /> : null}
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
  </>;
}
