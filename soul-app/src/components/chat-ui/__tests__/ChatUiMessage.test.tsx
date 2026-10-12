import React from 'react';
import { Platform, Text } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import * as Contract from '@soulstream/chat-ui';
import { ChatUiControllerProvider, type AppendGeneratedText } from '../ChatUiControllerProvider';
import { ChatUiMessage } from '../ChatUiMessage';
import { ChatUiNotice } from '../ChatUiNotice';
import { readChatUiPublication } from '../chatUiPublication';
import { chatUiDocuments, chatUiFixtureEvent, chatUiCoverageDocument } from '../../../component-review/chat-ui-fixtures';
import type { SessionEvent } from '../../../api/types';

// Follow AssistantMessage.test.tsx: native markdown is a Text stand-in. Slider
// exposes the installed public value/onValueChange contract, not native gestures.
jest.mock('react-native-enriched-markdown', () => {
  const React = require('react'); const { Text } = require('react-native');
  return { EnrichedMarkdownText: (props: any) => React.createElement(Text, { ...props, testID: 'assistant-markdown' }, props.markdown) };
});
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@soulstream/chat-ui', () => {
  const actual = jest.requireActual('@soulstream/chat-ui');
  return { ...actual, renderParts: jest.fn(actual.renderParts) };
});
jest.mock('@react-native-community/slider', () => {
  const React = require('react'); const { View } = require('react-native');
  return (props: any) => React.createElement(View, props);
});
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(() => Promise.resolve()) }));
const mockOpenLink = jest.fn(() => Promise.resolve());
jest.mock('../../../hooks/useOpenContentLink', () => ({ useOpenContentLink: () => mockOpenLink }));

const append = jest.fn<ReturnType<AppendGeneratedText>, Parameters<AppendGeneratedText>>(() => ({ ok: true }));
function sample(event = chatUiFixtureEvent('normal'), sessionId = 'session-one', shown = true) {
  return <ChatUiControllerProvider sessionId={sessionId} appendGeneratedText={append}>
    {shown && <ChatUiMessage event={event} />}
    <ChatUiNotice />
  </ChatUiControllerProvider>;
}
afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

test('unknown publication boundary selects valid rich, absent, unsupported and saved-text branches', () => {
  expect(readChatUiPublication({ content: 'plain' }).kind).toBe('absent');
  expect(readChatUiPublication(chatUiFixtureEvent('normal').data).kind).toBe('rich');
  expect(readChatUiPublication(chatUiFixtureEvent('normal', { schema_version: 2 }).data).kind).toBe('unsupported');
  expect(readChatUiPublication(chatUiFixtureEvent('normal', { document: { schema_version: 2 } }).data).kind).toBe('invalid');
  expect(readChatUiPublication(chatUiFixtureEvent('normal', { document: null }).data).kind).toBe('invalid');
  for (const overrides of [{ ui_id: '' }, { hash: 'wrong' }, { revision: 2 }]) {
    expect(readChatUiPublication(chatUiFixtureEvent('normal', overrides).data).kind).toBe('invalid');
  }
});

test('number, increment, slider and checkbox actions update shared results, visibility, copy and compose', async () => {
  const event = chatUiFixtureEvent('normal'); const screen = render(sample(event));
  expect(screen.getByText('232,000원/월')).toBeTruthy();
  expect(screen.queryByText('10명 이상이면 팀 예산을 함께 확인해.')).toBeNull();
  fireEvent.changeText(screen.getByLabelText('인원수'), '11');
  fireEvent.press(screen.getByLabelText('인원수 늘리기'));
  fireEvent.press(screen.getByLabelText('연간 결제 (20% 할인)'));
  expect(screen.getByText('278,400원/월')).toBeTruthy();
  expect(screen.getByText('10명 이상이면 팀 예산을 함께 확인해.')).toBeTruthy();
  expect(screen.getByTestId('chat-ui-slider-seats').props.value).toBe(12);
  await act(async () => fireEvent.press(screen.getByLabelText('복사')));
  const validation = Contract.validateChatUiDocument(chatUiDocuments.normal);
  if (!validation.ok) throw Error('fixture');
  const state = Contract.reduce(validation.document,
    Contract.reduce(validation.document, Contract.initialState(validation.document), { type: 'set', field: 'seats', value: 12 }),
    { type: 'set', field: 'annual', value: true });
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith(Contract.renderText(validation.document, state));
  expect(screen.getByText('현재 값 복사됨')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('이 조건으로 질문'));
  expect(append).toHaveBeenCalledWith('session-one', Contract.composeText(validation.document, state, 'compose'));
  expect(screen.queryByText('현재 값 복사됨')).toBeNull();
  fireEvent(screen.getByTestId('chat-ui-slider-seats'), 'valueChange', 9);
  fireEvent.press(screen.getByLabelText('인원수 줄이기'));
  expect(screen.getByText('185,600원/월')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('초기화'));
  expect(screen.getByText('232,000원/월')).toBeTruthy();
  expect(screen.getByTestId('chat-ui-slider-seats').props.value).toBe(8);
  expect(screen.getByText('기본값으로 돌아갔어')).toBeTruthy();
});

test('all five form fields, search selection, set action and reset flow through user controls', () => {
  const screen = render(sample(chatUiFixtureEvent('gallery')));
  fireEvent.changeText(screen.getByLabelText('인원수 (명)'), '15');
  fireEvent.changeText(screen.getByLabelText('덧붙일 말'), '검수 후 진행');
  fireEvent.press(screen.getByLabelText('결과 알림'));
  fireEvent.press(screen.getByLabelText('진행 순서: 앱 먼저'));
  fireEvent.changeText(screen.getByLabelText('진행 순서 검색'), '없음');
  expect(screen.getByText('검색 결과가 없습니다.')).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('진행 순서 검색'), '웹 먼저');
  fireEvent.press(screen.getByLabelText('웹 먼저'));
  expect(screen.queryByLabelText('진행 순서 검색')).toBeNull();
  fireEvent.press(screen.getByLabelText('전체 초기화'));
  fireEvent.press(screen.getByLabelText('이 값으로 요청'));
  expect(append.mock.calls[0][1]).toContain('검수 후 진행');
  expect(append.mock.calls[0][1]).toContain('웹 먼저');
  expect(append.mock.calls[0][1]).toContain('입력창 포커스, 전체 초기화');
  fireEvent.press(screen.getByLabelText('12명으로 설정'));
  expect(screen.getByLabelText('인원수 (명)').props.value).toBe('12');
  fireEvent.press(screen.getByLabelText('초기화'));
  expect(screen.getByLabelText('인원수 (명)').props.value).toBe('8');
  expect(screen.getByLabelText('덧붙일 말').props.value).toBe('');
  expect(screen.getByLabelText('결과 알림').props.accessibilityState.checked).toBe(true);
  expect(screen.getByLabelText('전체 초기화').props.accessibilityState.checked).toBe(false);
  expect(screen.getByLabelText('진행 순서: 앱 먼저')).toBeTruthy();
});

test.each([
  [1, 50, 1, 8, '999', ['9', '99', '999'], [9, 50, 50]],
  [2020, 2035, 1, 2026, '2028', ['2', '20', '202', '2028'], [2020, 2020, 2020, 2028]],
  [0, 100, 5, 20, '35', ['3', '35'], [5, 35]],
] as const)('typing preserves each draft in %s..%s step %s, blur restores the reducer value', (min, max, step, initial, text, drafts, values) => {
  for (const example of ['normal', 'gallery'] as const) {
    const document = { ...chatUiDocuments[example], fields: { ...chatUiDocuments[example].fields,
      seats: { ...chatUiDocuments[example].fields!.seats, type: 'number' as const, min, max, step, initial } } };
    const screen = render(sample(chatUiFixtureEvent(example, { document })));
    const input = () => screen.getByLabelText(example === 'normal' ? '인원수' : '인원수 (명)');
    fireEvent(input(), 'focus'); fireEvent.changeText(input(), '');
    for (let index = 0; index < text.length; index++) {
      fireEvent.changeText(input(), text.slice(0, index + 1));
      expect(input().props.value).toBe(drafts[index]);
      expect(screen.getByTestId('chat-ui-slider-seats').props.value).toBe(values[index]);
    }
    fireEvent(input(), 'blur'); expect(input().props.value).toBe(String(values.at(-1)));
    fireEvent.changeText(input(), ''); fireEvent(input(), 'blur');
    expect(input().props.value).toBe(String(values.at(-1)));
    screen.unmount();
  }
});

test('outside number actions replace a focused draft, and compose restores empty or invalid drafts', () => {
  const screen = render(sample(chatUiFixtureEvent('gallery')));
  const input = () => screen.getByLabelText('인원수 (명)');
  fireEvent(input(), 'focus'); fireEvent.changeText(input(), '999');
  fireEvent.press(screen.getByLabelText('12명으로 설정'));
  expect(input().props.value).toBe('12');
  fireEvent.changeText(input(), ''); fireEvent(screen.getByTestId('chat-ui-slider-seats'), 'valueChange', 9);
  expect(input().props.value).toBe('9');
  fireEvent.changeText(input(), ''); fireEvent.press(screen.getByLabelText('인원수 늘리기'));
  expect(input().props.value).toBe('10');
  fireEvent.changeText(input(), ''); fireEvent.press(screen.getByLabelText('인원수 줄이기'));
  expect(input().props.value).toBe('9');
  fireEvent.changeText(input(), ''); fireEvent.press(screen.getByLabelText('초기화'));
  expect(input().props.value).toBe('8');
  for (const draft of ['', '-']) {
    fireEvent.changeText(input(), draft); fireEvent.press(screen.getByLabelText('이 값으로 요청'));
    expect(input().props.value).toBe('8');
    expect(append).toHaveBeenLastCalledWith('session-one', expect.any(String));
  }
});

test('row remount and same-publication history retain values and expanded entities; session/hash changes reset', () => {
  const event = chatUiFixtureEvent('normal'); const screen = render(sample(event));
  fireEvent.changeText(screen.getByLabelText('인원수'), '12');
  fireEvent.press(screen.getByLabelText('요금 가정'));
  screen.rerender(sample(event, 'session-one', false));
  screen.rerender(sample({ ...event, id: 'history-copy' }));
  expect(screen.getByLabelText('인원수').props.value).toBe('12');
  expect(screen.getByText('실제 서비스 요금이 아닌 계산 예시야.')).toBeTruthy();
  screen.rerender(sample(chatUiFixtureEvent('normal', { hash: 'b'.repeat(64) })));
  expect(screen.getByLabelText('인원수').props.value).toBe('8');
  screen.rerender(sample(event, 'session-two'));
  expect(screen.getByLabelText('인원수').props.value).toBe('8');
  screen.rerender(sample(event, 'session-one'));
  expect(screen.getByLabelText('인원수').props.value).toBe('8');
});

test.each(['wrong_session', 'not_ready', 'sending', 'disabled', 'too_long'] as const)('compose failure %s preserves the document and uses agreed notice', reason => {
  append.mockReturnValueOnce({ ok: false, reason });
  const screen = render(sample()); fireEvent.press(screen.getByLabelText('이 조건으로 질문'));
  expect(screen.getByText(reason === 'too_long' ? '입력창이 가득 차서 더하지 못했어.' : '지금은 입력창에 더할 수 없어.')).toBeTruthy();
  expect(screen.getByText('232,000원/월')).toBeTruthy();
});

test('copy rejection is reported without changing values', async () => {
  jest.mocked(Clipboard.setStringAsync).mockRejectedValueOnce(Error('clipboard'));
  const screen = render(sample()); await act(async () => fireEvent.press(screen.getByLabelText('복사')));
  expect(screen.getByText('복사하지 못했어.')).toBeTruthy();
});

test('source citation, remaining source and open_source action use existing link owner only on press; assumption is text', () => {
  const event = chatUiFixtureEvent('gallery', { document: chatUiCoverageDocument });
  const screen = render(sample(event)); expect(mockOpenLink).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole('link', { name: 'OpenUI 원문' }));
  expect(mockOpenLink).toHaveBeenLastCalledWith(chatUiCoverageDocument.sources!.original.type === 'external_link' ? chatUiCoverageDocument.sources!.original.url : '');
  fireEvent.press(screen.getByLabelText('참고 자료 열기'));
  expect(mockOpenLink).toHaveBeenLastCalledWith('https://www.openui.com/docs/openui-lang/renderer');
  expect(screen.getAllByText(/^계산 가정:/)).toHaveLength(1);
  expect(screen.queryByRole('link', { name: '계산 가정' })).toBeNull();
});

test('RN웹 출처는 anchor 기본 이동을 막고 앱 링크 경로를 한 번 실행한다', () => {
  const previous = Platform.OS;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  try {
    const screen = render(sample());
    const preventDefault = jest.fn();
    fireEvent(screen.getByRole('link', { name: 'OpenUI 원문' }), 'press', { preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(mockOpenLink).toHaveBeenCalledTimes(1);
  } finally { Object.defineProperty(Platform, 'OS', { configurable: true, value: previous }); }
});

test('absent UI keeps stored content without a notice; invalid/missing documents use saved content', () => {
  const plain: SessionEvent = { id: 'plain', type: 'assistant_message', data: { content: '저장된 글' } };
  const screen = render(sample(plain)); expect(screen.getByTestId('assistant-markdown').props.markdown).toBe('저장된 글');
  expect(screen.queryByTestId('chat-ui-fallback-notice')).toBeNull();
  for (const document of [undefined, { schema_version: 2 }, { ...chatUiDocuments.normal, body: [{ kind: 'unknown' }] }]) {
    screen.rerender(sample({ ...chatUiFixtureEvent('normal', { document }), data: { ...chatUiFixtureEvent('normal', { document }).data, content: '저장된 글' } }));
    expect(screen.getByTestId('assistant-markdown').props.markdown).toBe('저장된 글');
    expect(screen.getByText('화면을 표시하지 못했어. 저장된 글로 보여줄게.')).toBeTruthy();
  }
});

test('unsupported envelope uses default text and actual AssistantMessage markdown', () => {
  const screen = render(sample(chatUiFixtureEvent('normal', { schema_version: 2 })));
  expect(screen.getByText('이 버전에서는 기본값 글로 보여줄게.')).toBeTruthy();
  expect(screen.getByTestId('assistant-markdown').props.markdown).toContain('232,000원/월');
  expect(screen.getByTestId('assistant-markdown').props.markdown).toContain('https://www.openui.com/docs/openui-lang/renderer');
});

test('a renderer exception after edits falls back to defaults, retains saved event, and a new hash gets a fresh boundary', () => {
  const event = chatUiFixtureEvent('normal'); const screen = render(sample(event));
  fireEvent.changeText(screen.getByLabelText('인원수'), '12');
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  const parts = jest.spyOn(Contract, 'renderParts').mockImplementation(() => { throw Error('renderer-failure-private'); });
  screen.rerender(sample({ ...event, id: 'rerender' }));
  expect(screen.getByText('화면을 표시하지 못했어. 기본값 글로 보여줄게.')).toBeTruthy();
  expect(screen.getByTestId('assistant-markdown').props.markdown).toContain('232,000원/월');
  expect(screen.queryByText('renderer-failure-private')).toBeNull();
  expect(event.data).toEqual(chatUiFixtureEvent('normal').data);
  parts.mockImplementation(jest.requireActual('@soulstream/chat-ui').renderParts); error.mockRestore();
  screen.rerender(sample(chatUiFixtureEvent('normal', { hash: 'b'.repeat(64) })));
  expect(screen.getByText('232,000원/월')).toBeTruthy();
});


test.each([2, null])('long fallback notices can wrap instead of truncating (%s)', schemaVersion => {
  const event = chatUiFixtureEvent('normal', { document: schemaVersion === null ? undefined : { schema_version: schemaVersion } });
  const screen = render(sample(event));
  expect(screen.getByTestId('chat-ui-fallback-notice').props.numberOfLines).toBeUndefined();
});

test.each(['number', 'slider', 'plus', 'minus', 'checkbox', 'choice', 'text', 'selection', 'set'] as const)(
  'value change through %s clears the previous reset/copy notice', async path => {
    const screen = render(sample(chatUiFixtureEvent('gallery')));
    const change = () => {
      if (path === 'number') fireEvent.changeText(screen.getByLabelText('인원수 (명)'), '12');
      if (path === 'slider') fireEvent(screen.getByTestId('chat-ui-slider-seats'), 'valueChange', 12);
      if (path === 'plus') fireEvent.press(screen.getByLabelText('인원수 늘리기'));
      if (path === 'minus') fireEvent.press(screen.getByLabelText('인원수 줄이기'));
      if (path === 'checkbox') fireEvent.press(screen.getByLabelText('연간 결제 (20% 할인)'));
      if (path === 'choice') { fireEvent.press(screen.getByLabelText('진행 순서: 앱 먼저')); fireEvent.press(screen.getByLabelText('웹 먼저')); }
      if (path === 'text') fireEvent.changeText(screen.getByLabelText('덧붙일 말'), '새 값');
      if (path === 'selection') fireEvent.press(screen.getByLabelText('전체 초기화'));
      if (path === 'set') fireEvent.press(screen.getByLabelText('12명으로 설정'));
    };
    fireEvent.press(screen.getByLabelText('초기화')); expect(screen.getByText('기본값으로 돌아갔어')).toBeTruthy();
    change(); expect(screen.queryByTestId('chat-ui-action-notice')).toBeNull();
    fireEvent.press(screen.getByLabelText('초기화'));
    await act(async () => fireEvent.press(screen.getByLabelText('복사')));
    expect(screen.getByText('현재 값 복사됨')).toBeTruthy();
    change(); expect(screen.queryByTestId('chat-ui-action-notice')).toBeNull();
});
