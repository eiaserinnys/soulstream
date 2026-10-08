import { act, fireEvent, render } from '@testing-library/react-native';
import { Image, StyleSheet, View } from 'react-native';
import { AssistantMessage } from '../AssistantMessage';
import { UserMessage } from '../UserMessage';
import { ChatComposer } from '../../chat/ChatComposer';
import { TypingIndicator } from '../../chat/TypingIndicator';
import { ChatToolApprovalRequest } from '../../chat/ChatToolApprovalRequest';
import { SystemEvent } from '../SystemEvent';
import { AttachmentChips } from '../../chat/AttachmentChips';
import { ToolEvent } from '../ToolEvent';
import { ThinkingEvent } from '../ThinkingEvent';
import { TurnSummaryCaption } from '../TurnSummaryCaption';
import { LabeledDivider } from '../../chat/LabeledDivider';
import { message } from '../../../component-review/fixtures';
import { useSettingsStore } from '../../../store/settingsStore';
import { DARK_COLORS, LIGHT_COLORS, LIGHT_PERSISTENT_SESSION_COLORS } from '../../../theme/colors';
import * as attachmentImageSize from '../../../lib/attachment-image-size';

afterEach(() => jest.restoreAllMocks());

test('원고형은 기존 메시지 부품에서 말풍선을 없애고 기본 채팅은 말풍선을 유지한다', () => {
  const event = message('user_message', '내가 보낸 요청입니다.');
  const standardUser = render(<UserMessage event={event} />);
  const standardBubble = StyleSheet.flatten(standardUser.getByTestId('user-message-bubble').props.style);
  expect(standardBubble.backgroundColor).toBeTruthy();

  const manuscriptUser = render(<UserMessage presentation="manuscript" event={event} />);
  const manuscriptBubble = StyleSheet.flatten(manuscriptUser.getByTestId('user-message-bubble').props.style);
  const manuscriptText = StyleSheet.flatten(manuscriptUser.getByTestId('user-message-text').props.style);
  expect(manuscriptUser.UNSAFE_queryAllByType(Image)).toHaveLength(0);
  expect(manuscriptBubble.backgroundColor).toBeUndefined();
  expect(manuscriptText.textAlign).toBe('right');
  expect(manuscriptText.color).toBe(LIGHT_COLORS.textMuted);
  expect(DARK_COLORS.textSecondary).toBe('#d8d8de');
  expect(manuscriptText.lineHeight).toBe(manuscriptText.fontSize * 1.6);

  const assistantEvent = message('text_delta', '에이전트 본문입니다.');
  const standardAssistant = render(<AssistantMessage event={assistantEvent} />);
  const standardAssistantBubble = StyleSheet.flatten(standardAssistant.getByTestId('assistant-message-bubble').props.style);
  expect(standardAssistantBubble.backgroundColor).toBeTruthy();

  const manuscriptAssistant = render(<AssistantMessage presentation="manuscript" event={assistantEvent} />);
  const manuscriptAssistantBubble = StyleSheet.flatten(manuscriptAssistant.getByTestId('assistant-message-bubble').props.style);
  expect(manuscriptAssistant.UNSAFE_queryAllByType(Image)).toHaveLength(0);
  expect(manuscriptAssistantBubble.backgroundColor).toBeUndefined();
  expect(manuscriptAssistantBubble.maxWidth).toBeUndefined();
  const manuscriptAssistantText = StyleSheet.flatten(manuscriptAssistant.getByTestId('assistant-streaming-text').props.style);
  expect(manuscriptAssistantText.lineHeight).toBe(manuscriptAssistantText.fontSize * 1.6);
});

test('원고형은 대기·승인·오류·도구·생각·담당 카드·첨부 표면을 열에 맞춘다', () => {
  const session = { agentSessionId: 'session-1', nodeId: 'node-1' } as never;
  const typing = render(<TypingIndicator presentation="manuscript" session={session} />);
  const typingRow = typing.UNSAFE_getAllByType(View)[0];
  expect(typingRow).toBeTruthy();
  expect(StyleSheet.flatten(typingRow?.props.style).marginHorizontal).toBe(0);
  expect(typing.UNSAFE_queryAllByType(Image)).toHaveLength(0);
  const typingSurface = StyleSheet.flatten(typing.getByTestId('typing-indicator-bubble').props.style);
  expect(typingSurface.backgroundColor).toBeUndefined();
  expect(typingSurface.borderWidth).toBeUndefined();
  expect(typingSurface.paddingHorizontal).toBeUndefined();

  const approval = render(<ChatToolApprovalRequest presentation="manuscript" event={{
    id: 'approval', type: 'tool_approval_requested', data: { approval_id: 'approval-1', tool_name: 'Read' },
  }} sessionId="session-1" />);
  const approvalRow = approval.UNSAFE_getAllByType(View)[0];
  expect(StyleSheet.flatten(approvalRow?.props.style).paddingHorizontal).toBe(0);

  const error = render(<SystemEvent presentation="manuscript" event={{ id: 'error', type: 'error', data: { message: '실패' } }} />);
  expect(StyleSheet.flatten(error.UNSAFE_getAllByType(View)[0].props.style).paddingHorizontal).toBe(0);

  const chips = render(<AttachmentChips presentation="manuscript" attachments={[{ path: '/a', name: '대기.png' }]}
    styles={{ attachmentRow: {}, attachmentTouchFrame: {}, attachmentChip: {}, attachmentRemoveSpacer: {},
      attachmentRemoveFrame: {}, attachmentRemove: {}, attachmentName: {} } as never}
    textSecondaryColor="#000" textMutedColor="#000" onRemove={() => {}} />);
  const chip = chips.UNSAFE_getAllByType(View)[2];
  expect(StyleSheet.flatten(chip?.props.style).backgroundColor).toBe(LIGHT_PERSISTENT_SESSION_COLORS.paper);
  expect(StyleSheet.flatten(chip?.props.style).borderColor).toBe(LIGHT_PERSISTENT_SESSION_COLORS.line);

  const tool = render(<ToolEvent presentation="manuscript" start={message('tool_start', '')}
    result={message('tool_result', '')} sessionId="session-1" />);
  const toolRow = tool.getByTestId('tool-event-row-slot');
  const toolSurface = tool.getByTestId('tool-event-wrapper');
  expect(StyleSheet.flatten(toolRow.props.style).marginRight).toBe(0);
  expect(StyleSheet.flatten(toolSurface.props.style).backgroundColor).toBeUndefined();
  expect(StyleSheet.flatten(toolSurface.props.style).borderWidth).toBeUndefined();

  const thinking = render(<ThinkingEvent presentation="manuscript" event={{
    id: 'thinking', type: 'thinking_delta', data: { thinking: '생각 내용' },
  }} />);
  const thinkingText = thinking.getByTestId('thinking-event-text');
  const thinkingTextStyle = StyleSheet.flatten(thinkingText.props.style);
  expect(thinking.getByText('생각 내용')).toBeTruthy();
  expect(thinking.queryByText('생각 중...')).toBeNull();
  expect(thinkingTextStyle).toMatchObject({
    color: LIGHT_COLORS.textPrimary,
  });
  expect(thinkingTextStyle.lineHeight).toBe(thinkingTextStyle.fontSize * 1.6);
  expect(thinking.UNSAFE_queryAllByType(View)).toHaveLength(0);

  const summary = render(<TurnSummaryCaption presentation="manuscript" content="담당 카드 기록" />);
  const summarySurface = summary.getByTestId('turn-summary-caption-bubble');
  expect(StyleSheet.flatten(summarySurface.props.style).backgroundColor).toBe(LIGHT_PERSISTENT_SESSION_COLORS.panel);
  expect(StyleSheet.flatten(summarySurface.props.style).borderColor).toBe(LIGHT_PERSISTENT_SESSION_COLORS.line);

  const divider = render(<LabeledDivider label="새 세대" lineColor="#123456" />);
  expect(StyleSheet.flatten(divider.UNSAFE_getAllByType(View)[1].props.style).backgroundColor).toBe('#123456');
});

test('일반 채팅 Thinking 블록은 라벨과 개별 접힘을 유지한다', () => {
  const thinking = render(<ThinkingEvent event={{
    id: 'thinking-default', type: 'thinking_delta', data: { thinking: '일반 채팅 생각 내용' },
  }} />);
  expect(thinking.getByText('생각 중...')).toBeTruthy();
  expect(thinking.queryByText('일반 채팅 생각 내용')).toBeNull();
  fireEvent.press(thinking.getByText('생각 중...'));
  expect(thinking.getByText('일반 채팅 생각 내용')).toBeTruthy();
});

test('원고형 입력의 줄 간격과 높이는 기본 입력을 유지하고 멀티라인 왼쪽 여백은 0이다', () => {
  const props = { input: '여러 줄 입력\n둘째 줄', onChangeInput: () => {}, onPickAttachment: () => {}, onSend: () => {},
    uploading: false, sending: false, voiceControls: null };
  const regular = render(<ChatComposer {...props} />);
  const manuscript = render(<ChatComposer {...props} presentation="manuscript" />);
  const regularInput = StyleSheet.flatten(regular.getByTestId('chat-composer-text-input').props.style);
  fireEvent(manuscript.getByTestId('chat-composer-text-input'), 'contentSizeChange', {
    nativeEvent: { contentSize: { height: 100, width: 100 } },
  });
  const manuscriptInput = StyleSheet.flatten(manuscript.getByTestId('chat-composer-text-input').props.style);
  expect(manuscriptInput.lineHeight).toBe(regularInput.lineHeight);
  expect(manuscriptInput.paddingHorizontal).toBe(0);
});

test('원고형 전송 실패와 선택 작업은 종이 위에서 읽히는 색을 쓴다', () => {
  const event = message('user_message', '실패한 메시지');
  const failed = render(<UserMessage presentation="manuscript" event={event} pendingStatus="failed"
    failureReason="전송하지 못했습니다." onRetry={() => {}} onRestore={() => {}} />);
  const retryText = failed.getByText('다시 보내기');
  const restoreText = failed.getByText('입력창으로');
  const reason = failed.getByTestId('pending-message-failure-reason');
  expect(StyleSheet.flatten(retryText.props.style).color).toBe(LIGHT_COLORS.textPrimary);
  expect(StyleSheet.flatten(restoreText.props.style).color).toBe(LIGHT_COLORS.textPrimary);
  expect(StyleSheet.flatten(reason.props.style).color).toBe(LIGHT_COLORS.errorText);

  const selection = render(<UserMessage presentation="manuscript" event={event}
    selectionModel={{ kind: 'plain', text: '선택할 문장' }} onSelectionDone={() => {}} />);
  expect(StyleSheet.flatten(selection.getByText('완료').props.style).color).toBe(LIGHT_COLORS.textPrimary);

  const assistantSelection = render(<AssistantMessage presentation="manuscript"
    event={message('assistant_message', '선택할 답변')}
    selectionModel={{ kind: 'plain', text: '선택할 답변' }} onSelectionDone={() => {}} />);
  expect(StyleSheet.flatten(assistantSelection.getByText('완료').props.style).color).toBe(LIGHT_COLORS.textPrimary);
});

test.each(['normal', 'intervention'] as const)('원고형 %s 발언은 글과 함께 있는 첨부를 오른쪽 끝에 놓는다', async variant => {
  useSettingsStore.setState({ serverUrl: 'https://chat.test' });
  jest.spyOn(attachmentImageSize, 'getAttachmentImageSize').mockResolvedValue({ width: 390, height: 844 });
  const screen = render(<UserMessage presentation="manuscript" variant={variant}
    session={{ nodeId: 'node-1' }}
    event={{ id: 'attached', type: 'user_message', data: {
      text: '첨부 두 장이 달린 조금 긴 내 발언입니다.', attachments: ['/files/one.png', '/files/two.png'],
    } }} />);
  await act(async () => { await Promise.resolve(); });
  const gallery = screen.getByTestId('user-chat-image-gallery');
  expect(StyleSheet.flatten(gallery.props.style).alignSelf).toBe('flex-end');
});

test('원고형 입력 밑줄과 조작부는 열 가장자리에 맞추고 기본 입력 여백은 유지한다', () => {
  const props = {
    input: '한 줄 입력', onChangeInput: () => {}, onPickAttachment: () => {}, onSend: () => {},
    uploading: false, sending: false, voiceControls: null,
  };
  const standard = render(<ChatComposer {...props} />);
  const manuscript = render(<ChatComposer {...props} presentation="manuscript" />);
  const standardBox = StyleSheet.flatten(standard.getByTestId('chat-composer-box').props.style);
  const manuscriptBox = StyleSheet.flatten(manuscript.getByTestId('chat-composer-box').props.style);
  const attachmentSlot = StyleSheet.flatten(manuscript.getByTestId('chat-composer-attach-slot').props.style);
  const sendFrame = StyleSheet.flatten(manuscript.getByTestId('chat-composer-send-button').props.style);

  expect(standardBox.paddingHorizontal).toBeGreaterThan(0);
  expect(manuscriptBox.paddingHorizontal).toBe(0);
  expect(manuscriptBox.borderBottomWidth).toBe(StyleSheet.hairlineWidth);
  expect(manuscriptBox.borderBottomColor).toBeTruthy();
  expect(attachmentSlot.marginLeft).toBeLessThan(0);
  expect(sendFrame.marginRight).toBeLessThan(0);
});

test('원고형 사용자 메시지의 이미지를 chat refined 뷰어에서 연다', async () => {
  useSettingsStore.setState({ serverUrl: 'https://chat.test' });
  jest.spyOn(attachmentImageSize, 'getAttachmentImageSize').mockResolvedValue({ width: 390, height: 844 });
  const screen = render(<UserMessage
    presentation="manuscript"
    session={{ nodeId: 'node-1' }}
    event={{ id: 'attached', type: 'user_message', data: { text: '첨부 확인', attachments: ['/files/image.png'] } }}
  />);

  await act(async () => { await Promise.resolve(); });
  fireEvent.press(screen.getByLabelText('image.png 크게 보기'));
  expect(screen.getByTestId('chat-image-viewer-viewport')).toBeTruthy();
  fireEvent.press(screen.getByTestId('chat-image-viewer-close'));
  expect(screen.queryByTestId('chat-image-viewer-viewport')).toBeNull();
});
