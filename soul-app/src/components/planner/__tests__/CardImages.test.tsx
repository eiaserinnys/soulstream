import React from 'react';
import { fireEvent, render, within } from '@testing-library/react-native';
import { Image } from 'react-native';
import { CardTimeline } from '../CardTimeline';
import { CardRequestView } from '../CardRequestView';
import { UserMessage } from '../../events/UserMessage';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { cardFixture } from '../../../test-support/cards';
import type { CardDetail } from '../../../api/cardTypes';

jest.mock('react-native-webview', () => ({ WebView: 'WebView' }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../PlannerMarkdownText', () => ({ PlannerMarkdownText: ({ markdown, testID }: any) =>
  require('react').createElement(require('react-native').Text, { testID }, markdown) }));

const jwt = 'public-test-token';
const server = 'https://cards.test';
const first = '/api/attachments/files?nodeId=n&path=%2Ftmp%2Fone.png';
const second = server + '/api/attachments/files?nodeId=n&path=%2Ftmp%2Ftwo.png';
const third = 'https://other.test/three.png';
const detail: CardDetail = { card: cardFixture(), sessions: [], questions: [], comments: [], reports: [{
  id: 'images', cardId: 'card-1', title: '이미지 보고', format: 'markdown', createdAt: '2026-10-02T00:00:00Z',
  body: `처음\n\n![첫 사진](${first})\n\n사이\n\n![둘째](${second})\n\n![외부](${third})\n\n마지막`,
}] };
beforeEach(() => {
  useAuthStore.setState({ jwt });
  useSettingsStore.setState({ serverUrl: server });
});
afterEach(() => useAuthStore.setState({ jwt: null }));
const hasAuth = (source: any) => Boolean(source.headers?.Authorization);

test('접힌 두 썸네일과 전체 확대 갤러리에 인증 source를 전달한다', () => {
  const screen = render(<CardTimeline detail={detail} onChooseAnswer={() => {}} />);
  const thumbnails = screen.getAllByTestId(/card-report-thumbnail/);
  expect(thumbnails).toHaveLength(2);
  expect(thumbnails.map((image) => hasAuth(image.props.source))).toEqual([true, true]);
  expect(thumbnails[0].props.source.uri).toBe(server + first);
  fireEvent.press(thumbnails[0]);
  const pages = within(screen.getByTestId('image-viewer-pages'));
  const sources = pages.UNSAFE_getAllByType(Image).map((image) => image.props.source);
  expect(sources.map(hasAuth)).toEqual([true, true, false]);
  expect(sources.map((source) => source.uri)).toEqual([server + first, second, third]);
});

test('펼친 보고는 글 순서를 유지하고 preview 없이 본문 이미지로 전체 확대한다', () => {
  const screen = render(<CardTimeline detail={detail} onChooseAnswer={() => {}} />);
  fireEvent.press(screen.getByTestId('card-fold-report-images'));
  expect(screen.queryAllByTestId(/card-report-thumbnail/)).toHaveLength(0);
  expect(screen.getAllByTestId(/card-report-image-images-/)).toHaveLength(3);
  const parts = screen.getByTestId('card-report-markdown-images').props.children;
  expect(parts.filter(Boolean).map((part: any) => part.props.markdown?.trim() ?? part.props.accessibilityLabel))
    .toEqual(['처음', '첫 사진', '사이', '둘째', '외부', '마지막']);
  fireEvent.press(screen.getByTestId('card-report-image-images-2'));
  const sources = within(screen.getByTestId('image-viewer-pages')).UNSAFE_getAllByType(Image).map((image) => image.props.source);
  expect(sources.map(hasAuth)).toEqual([true, true, false]);
});

test.each([first, second])('웹 상대/앱 절대 커멘트 끝 첨부는 같은 인증 뷰어를 쓴다: %s', (url) => {
  const screen = render(<CardRequestView request={`커멘트\n\n![사진](${url})`} />);
  const image = screen.getByTestId('card-request-image-0');
  expect(hasAuth(image.props.source)).toBe(true);
  expect(image.props.source.uri.startsWith(server)).toBe(true);
  fireEvent.press(image);
  expect(within(screen.getByTestId('image-viewer-pages')).UNSAFE_getByType(Image).props.source).toEqual(image.props.source);
});

test('외부 커멘트는 인증하지 않고 중간 이미지 원문은 유지한다', () => {
  const screen = render(<CardRequestView request={`본문\n\n![외부](${third})`} />);
  expect(hasAuth(screen.getByTestId('card-request-image-0').props.source)).toBe(false);
  screen.rerender(<CardRequestView request={`본문\n![사진](${first})\n뒤의 설명`} />);
  expect(screen.queryByTestId('card-request-image-0')).toBeNull();
  expect(screen.getByText(/뒤의 설명/)).toBeTruthy();
});

test('HTML 썸네일도 같은 인증 source를 쓰며 기존 채팅 첨부 계약은 유지한다', () => {
  const htmlDetail: CardDetail = { ...detail, reports: [{ ...detail.reports[0], format: 'html', body: `<p>보고</p><img src="${first}">` }] };
  const screen = render(<CardTimeline detail={htmlDetail} onChooseAnswer={() => {}} />);
  expect(hasAuth(screen.getByTestId('card-report-thumbnail-images-0').props.source)).toBe(true);
  screen.unmount();
  const chat = render(<UserMessage event={{ id: 'chat', type: 'user_message', data: { text: '채팅', attachments: ['/tmp/one.png'], node_id: 'n' } }} />);
  const images = chat.UNSAFE_getAllByType(Image);
  expect(images.some((image) => hasAuth(image.props.source) && image.props.source.uri === server + first)).toBe(true);
});
