import { fireEvent, render } from '@testing-library/react-native';
import { Image, StyleSheet } from 'react-native';
import { AssistantMessage } from '../AssistantMessage';
import { UserMessage } from '../UserMessage';
import { ChatComposer } from '../../chat/ChatComposer';
import { message } from '../../../component-review/fixtures';
import { useSettingsStore } from '../../../store/settingsStore';
import { DARK_COLORS, LIGHT_COLORS } from '../../../theme/colors';

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
  expect(manuscriptText.color).toBe(LIGHT_COLORS.textSecondary);
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

test('원고형 사용자 메시지의 첨부도 기존 이미지 뷰어를 연다', () => {
  useSettingsStore.setState({ serverUrl: 'https://chat.test' });
  const screen = render(<UserMessage
    presentation="manuscript"
    session={{ nodeId: 'node-1' }}
    event={{ id: 'attached', type: 'user_message', data: { text: '첨부 확인', attachments: ['/files/image.png'] } }}
  />);

  fireEvent.press(screen.getByLabelText('첨부 이미지 1'));
  expect(screen.getByTestId('image-viewer-pages').props.pagingEnabled).toBe(true);
  fireEvent.press(screen.getByLabelText('이미지 닫기'));
  expect(screen.queryByTestId('image-viewer-pages')).toBeNull();
});
