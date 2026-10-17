import React from 'react';
import { fireEvent, render, waitFor, within } from '@testing-library/react-native';
import { Image, Platform } from 'react-native';
import { CardTimeline } from '../CardTimeline';
import { CardRequestView } from '../CardRequestView';
import { CardReportView } from '../CardReportView';
import { CardRow } from '../CardRow';
import { CardCreateSheet } from '../CardCreateSheet';
import { UserMessage } from '../../events/UserMessage';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { cardFixture } from '../../../test-support/cards';
import type { CardDetail } from '../../../api/cardTypes';
import type { AttachmentReadContext } from '../../../../../packages/wire-schema/src/attachments';
import { AttachmentReadContextProvider, useAttachmentReadContext, useAttachmentBlockLinks } from '../../../navigation/ContentLinkProvider';
import { useOpenContentLink } from '../../../hooks/useOpenContentLink';
import { openContentLinkNavigation } from '../../../lib/content-link-navigation';

jest.mock('react-native-webview', () => ({ WebView: 'WebView' }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../../hooks/useOpenContentLink', () => ({ useOpenContentLink: jest.fn() }));
jest.mock('../PlannerMarkdownText', () => ({ PlannerMarkdownText: ({ markdown }: any) => {
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  const { useOpenContentLink } = require('../../../hooks/useOpenContentLink');
  const { useAttachmentReadContext, useAttachmentBlockLinks } = jest.requireActual('../../../navigation/ContentLinkProvider');
  const openContentLink = useOpenContentLink();
  const context = useAttachmentReadContext();
  const href = markdown.match(/\[[^\]]*\]\(([^)]+)\)/)?.[1];
  return React.createElement(Pressable, {
    testID: href ? 'planner-markdown-text-link' : undefined,
    markdown,
    onPress: href ? () => { void openContentLink(href); } : undefined,
    accessibilityLabel: context ? JSON.stringify(context) : undefined,
  }, React.createElement(Text, null, markdown));
} }));

const jwt = 'public-test-token';
const server = 'https://cards.test';
const first = '/api/attachments/files?nodeId=n&path=%2Ftmp%2Fone.png';
const second = server + '/api/attachments/files?nodeId=n&path=%2Ftmp%2Ftwo.png';
const third = 'https://other.test/three.png';
const observedReadContexts: Array<AttachmentReadContext | undefined> = [];
const metadataRequest = jest.fn();
const openAttachment = jest.fn((view) => { void view.loadMetadata?.().catch(() => {}); });
const openExternal = jest.fn().mockResolvedValue(undefined);
const alert = jest.fn();
const detail: CardDetail = { card: cardFixture(), sessions: [], questions: [], comments: [], reports: [{
  id: 'images', cardId: 'card-1', title: '이미지 보고', format: 'markdown', createdAt: '2026-10-02T00:00:00Z',
  body: `처음\n\n![첫 사진](${first})\n\n사이\n\n![둘째](${second})\n\n![외부](${third})\n\n마지막`,
}] };
beforeEach(() => {
  observedReadContexts.length = 0;
  metadataRequest.mockReset().mockResolvedValue({ descriptor: {
    name: 'body.txt', mime_type: 'text/plain', byte_size: 8, preview_kind: 'text',
  } });
  openAttachment.mockClear();
  openExternal.mockReset().mockResolvedValue(undefined);
  alert.mockReset();
  jest.mocked(useOpenContentLink).mockImplementation((readContext?: AttachmentReadContext, links?: readonly { href: string; label: string }[]) => {
    const providerContext = useAttachmentReadContext();
    const blockLinks = useAttachmentBlockLinks();
    const effectiveContext = readContext ?? providerContext;
    observedReadContexts.push(effectiveContext);
    return (href: string) => openContentLinkNavigation({
      href,
      attachmentLinks: links ?? blockLinks,
      serverUrl: server,
      jwt: useAuthStore.getState().jwt,
      api: { getAttachmentMetadata: metadataRequest } as any,
      navigation: null,
      device: 'phone',
      readContext: effectiveContext,
      openAttachment,
      openExternal,
      alert,
    });
  });
  useAuthStore.setState({ jwt });
  useSettingsStore.setState({ serverUrl: server });
});
afterEach(() => useAuthStore.setState({ jwt: null }));
const hasAuth = (source: any) => Boolean(source.headers?.Authorization);

test('접힌 두 썸네일의 카드 인증 source와 공통 보기 목록을 전달한다', () => {
  const screen = render(<CardTimeline detail={detail} onChooseAnswer={() => {}} />);
  const thumbnails = screen.getAllByTestId(/card-report-thumbnail/);
  expect(thumbnails).toHaveLength(2);
  expect(thumbnails.map((image) => hasAuth(image.props.source))).toEqual([true, true]);
  expect(thumbnails[0].props.source.uri).toBe(server + first + '&context_type=card&context_id=card-1');
  fireEvent.press(thumbnails[0]);
  const [selected, items, index] = openAttachment.mock.calls[0] as any[];
  expect(index).toBe(0);
  expect(items.map((item: any) => item.name)).toEqual(['첫 사진', '둘째']);
  expect(selected.readContext).toEqual({ type: 'card', id: 'card-1' });
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
  expect(image.props.source.uri).toContain('/api/attachments/files?');
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

test('D13 Timeline, report, board row, draft preview는 실제 카드 또는 owner 문맥을 전달한다', () => {
  const timelineDetail: CardDetail = { ...detail, card: cardFixture({ id: 'timeline-card', request: '요청 본문' }), reports: [] };
  const timeline = render(<CardTimeline detail={timelineDetail} onChooseAnswer={() => {}} />);
  fireEvent.press(timeline.getByTestId('card-fold-request'));
  expect(observedReadContexts).toContainEqual({ type: 'card', id: 'timeline-card' });
  timeline.unmount();

  observedReadContexts.length = 0;
  const report = render(<CardReportView report={{ id: 'report-context', cardId: 'report-card', title: '보고', format: 'markdown', body: '본문 링크', createdAt: '' }} />);
  expect(observedReadContexts).toContainEqual({ type: 'card', id: 'report-card' });
  report.unmount();

  observedReadContexts.length = 0;
  const row = render(<CardRow api={null} card={cardFixture({ id: 'row-card' })} board onOpen={() => {}} />);
  expect(observedReadContexts).toContainEqual({ type: 'card', id: 'row-card' });
  row.unmount();

  observedReadContexts.length = 0;
  const latestRow = render(<CardRow api={null} card={cardFixture({ id: 'latest-row-card', latestActivity: {
    kind: 'instruction', body: '최신 활동', format: 'markdown', createdAt: '',
  } })} board onOpen={() => {}} />);
  expect(observedReadContexts).toContainEqual({ type: 'card', id: 'latest-row-card' });
  latestRow.unmount();

  observedReadContexts.length = 0;
  render(<CardCreateSheet api={null} onClose={() => {}} />);
  expect(observedReadContexts).toContainEqual({ type: 'owner' });
});

test('D13 명시 readContext는 가까운 provider보다 우선한다', async () => {
  const explicitContext: AttachmentReadContext = { type: 'card', id: 'explicit-card' };
  const inheritedContext: AttachmentReadContext = { type: 'card', id: 'provider-card' };
  const href = `${server}/api/attachments/explicit-file/content`;
  const screen = render(<AttachmentReadContextProvider context={inheritedContext}>
    <CardRequestView request={`첨부: body.txt(${href})`} readContext={explicitContext} />
  </AttachmentReadContextProvider>);
  fireEvent.press(screen.getByText('body.txt'));
  await waitFor(() => expect(metadataRequest).toHaveBeenCalledWith('explicit-file', explicitContext));
  expect(metadataRequest).not.toHaveBeenCalledWith('explicit-file', inheritedContext);
});

test('D13 문맥 없는 Markdown 링크는 보고 카드 문맥을 상속한다', async () => {
  const screen = render(<CardReportView report={{
    id: 'report-contextless', cardId: 'report-card', title: '보고', format: 'markdown',
    body: '[파일](/api/attachments/contextless-file/content)', createdAt: '',
  }} />);
  fireEvent.press(screen.getByTestId('planner-markdown-text-link'));
  await waitFor(() => expect(metadataRequest).toHaveBeenCalledWith('contextless-file', { type: 'card', id: 'report-card' }));
});

test('보고 본문 누름은 바깥 접기로 전파되지 않고 링크를 다시 열 수 있다', async () => {
  const linkDetail: CardDetail = { ...detail, reports: [{ ...detail.reports[0],
    body: '[파일](/api/attachments/report-file/content)',
  }] };
  const screen = render(<CardTimeline detail={linkDetail} onChooseAnswer={() => {}} />);
  const fold = () => screen.getByTestId('card-fold-report-images');
  fireEvent.press(fold());
  fireEvent.press(screen.getByTestId('planner-markdown-text-link'));
  await waitFor(() => expect(openAttachment).toHaveBeenCalledTimes(1));

  const body = screen.getByTestId('card-report-markdown-images');
  // The body owns empty-space touches without introducing a pressable control.
  expect(body.props.onPress).toBeUndefined();
  expect(body.props.onStartShouldSetResponder()).toBe(true);
  // A parent scroll/pager can take over a gesture that starts in the body.
  expect(body.props.onResponderTerminationRequest()).toBe(true);
  expect(screen.getByTestId('card-report-markdown-images')).toBeTruthy();
  fireEvent.press(screen.getByTestId('planner-markdown-text-link'));
  await waitFor(() => expect(openAttachment).toHaveBeenCalledTimes(2));
  expect(metadataRequest).toHaveBeenLastCalledWith('report-file', { type: 'card', id: 'card-1' });

  fireEvent.press(fold());
  expect(screen.queryByTestId('card-report-markdown-images')).toBeNull();
  fireEvent.press(fold());
  expect(screen.getByTestId('planner-markdown-text-link')).toBeTruthy();
});

test('D13 Markdown 링크 URL 문맥은 현재 보고 카드 문맥보다 우선한다', async () => {
  const screen = render(<CardReportView report={{
    id: 'report-url-context', cardId: 'report-card', title: '보고', format: 'markdown',
    body: '[파일](/api/attachments/url-context-file/content?context_type=card&context_id=url-card)', createdAt: '',
  }} />);
  fireEvent.press(screen.getByTestId('planner-markdown-text-link'));
  await waitFor(() => expect(metadataRequest).toHaveBeenCalledWith('url-context-file', { type: 'card', id: 'url-card' }));
});

test.each(['ios', 'web'] as const)('%s 보고 본문은 웹에서만 DOM click 전파를 막는다', (platform) => {
  const os = jest.replaceProperty(Platform, 'OS', platform);
  try {
    const screen = render(<CardReportView report={{ ...detail.reports[0], body: '본문' }} />);
    const body = screen.getByTestId('card-report-markdown-images');
    const stopPropagation = jest.fn();
    if (platform === 'web') {
      fireEvent(body, 'click', { stopPropagation });
      expect(stopPropagation).toHaveBeenCalledTimes(1);
    } else {
      expect(body.props.onClick).toBeUndefined();
    }
  } finally {
    os.restore();
  }
});

test('D13 문맥 없는 legacy /files 링크는 보고 카드 문맥을 HEAD에 붙인다', async () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/plain', 'content-disposition': 'inline; filename="body.txt"' }),
  } as Response);
  global.fetch = fetchMock;
  try {
    const screen = render(<CardReportView report={{
      id: 'report-legacy-context', cardId: 'report-card', title: '보고', format: 'markdown',
      body: '[파일](/api/attachments/files?nodeId=node-1&path=%2Fincoming%2Fbody.txt)', createdAt: '',
    }} />);
    fireEvent.press(screen.getByTestId('planner-markdown-text-link'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `${server}/api/attachments/files?nodeId=node-1&path=%2Fincoming%2Fbody.txt&context_type=card&context_id=report-card`,
      expect.objectContaining({ method: 'HEAD' }),
    ));
    expect(openAttachment.mock.calls[0][0]).toEqual(expect.objectContaining({
      readContext: { type: 'card', id: 'report-card' },
      loadMetadata: expect.any(Function),
    }));
  } finally {
    global.fetch = originalFetch;
  }
});
