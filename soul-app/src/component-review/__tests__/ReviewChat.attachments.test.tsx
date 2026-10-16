import React from 'react';
import { fireEvent, render, renderHook, within } from '@testing-library/react-native';
import { Image, StyleSheet } from 'react-native';
import { ChatComposer } from '../../components/chat/ChatComposer';
import { getChatRowHorizontalInset } from '../../components/chat/ChatBody.styles';
import { useTokens } from '../../theme';
import { useSettingsStore } from '../../store/settingsStore';
import { ReviewChat } from '../ReviewChat';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../components/chat/ChatBody', () => ({ ChatBody: () => null }));
jest.mock('../../components/events/AssistantMessage', () => ({ AssistantMessage: () => null }));

beforeAll(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: { search: '', origin: 'https://review.test' } });
  useSettingsStore.setState({ serverUrl: 'https://review.test' });
});

beforeEach(() => {
  jest.spyOn(Image, 'getSizeWithHeaders').mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('첨부만 보낸 메시지 표본은 UserMessage에 이미지와 TXT를 연결한다', () => {
  const screen = render(<ReviewChat />);
  const sample = screen.getByTestId('review-chat-attachment-only-user-message');
  expect(within(sample).queryByTestId('user-message-text')).toBeNull();
  expect(within(sample).getByText('2026-10-17 서버 로그 전체.txt')).toBeTruthy();
  expect(within(sample).getByLabelText('첨부 이미지 1')).toBeTruthy();
  expect(within(sample).queryByLabelText('첨부 이미지 2')).toBeNull();
});

test('첨부만 전송 표본은 chips와 composer를 같은 간격 없는 그룹에 둔다', async () => {
  const screen = render(<ReviewChat />);
  fireEvent.press(screen.getByTestId('settings-segment-review-composer-state-attachment-only'));

  const group = screen.getByTestId('review-chat-composer-input-group');
  const children = React.Children.toArray(group.props.children) as React.ReactElement<any>[];
  expect(group.props.style).toMatchObject({ gap: 0 });
  expect(children[0]?.props.testID).toBe('review-chat-composer-generated-row');
  expect(children[1]?.type).toBe(ChatComposer);
  const inset = getChatRowHorizontalInset(renderHook(() => useTokens()).result.current);
  expect(StyleSheet.flatten(children[0]?.props.style)).toMatchObject({ paddingHorizontal: inset, paddingTop: 0 });
});

test('첨부 업로드 중 표본은 입력한 본문을 유지하고 첨부 칩을 보이지 않는다', async () => {
  const screen = render(<ReviewChat />);
  fireEvent.press(screen.getByTestId('settings-segment-review-composer-state-uploading'));
  fireEvent.changeText(screen.getByLabelText('공개 예시 메시지'), '본문을 입력한 상태');

  expect(screen.getByLabelText('공개 예시 메시지').props.value).toBe('본문을 입력한 상태');
  expect(within(screen.getByTestId('review-chat-composer')).queryByText('검수용 첨부.txt')).toBeNull();
  expect(screen.queryByTestId('review-chat-composer-generated-row')).toBeNull();
  const composer = within(screen.getByTestId('review-chat-composer-input-group')).UNSAFE_getByType(ChatComposer);
  expect(composer.props.uploading).toBe(true);
  expect(composer.props.sendDisabled).toBe(true);
});
