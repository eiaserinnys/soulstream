import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { CardRequestView } from '../CardRequestView';
import { CardTimeline } from '../CardTimeline';
import { ContentLinkProvider, AttachmentReadContextProvider } from '../../../navigation/ContentLinkProvider';
import { AttachmentPreviewModal } from '../../AttachmentPreviewModal';
import { MessageAttachments } from '../../MessageAttachments';
import { cardFixture } from '../../../test-support/cards';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { createApiClient } from '../../../api/client';
import { restoreAttachmentFocus } from '../../../lib/attachment-focus';
import { extractCardBodyLinks } from '../../../lib/card-body-attachments';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../../lib/attachment-focus', () => ({ restoreAttachmentFocus: jest.fn() }));
jest.mock('react-native-webview', () => ({ WebView: 'WebView' }));
jest.mock('../../../api/client', () => ({ createApiClient: jest.fn() }));
jest.mock('../../../lib/attachment-image-size', () => ({ getAttachmentImageSize: jest.fn(() => new Promise(() => {})) }));
// Native markdown's link event is supplied by the OS; keep the production link hook and host.
jest.mock('../PlannerMarkdownText', () => ({ PlannerMarkdownText: ({ markdown }: { markdown: string }) => {
  const React = require('react');
  const { Pressable, Text } = require('react-native');
  const open = require('../../../hooks/useOpenContentLink').useOpenContentLink();
  const href = markdown.match(/\]\(([^)]+)\)/)?.[1] ?? markdown.match(/\[a\]:\s*(\S+)/)?.[1];
  return <Pressable testID="body-link" onPress={() => open(href)}><Text>{markdown}</Text></Pressable>;
} }));
const context = { type: 'card' as const, id: 'card-1' };
const url = (id: string) => `/api/attachments/${id}/content`;
const metadata = jest.fn();
const ready = (id: string, kind = 'text') => ({ descriptor: { attachment_id: id, name: `${id}.${kind === 'image' ? 'png' : 'txt'}`,
  mime_type: kind === 'image' ? 'image/png' : 'text/plain', byte_size: 0, width: null, height: null,
  checksum_sha256: null, preview_kind: kind, preview_mime_type: null }, upload_status: 'committed' });
beforeEach(() => {
  useAuthStore.setState({ jwt: 'fixture-jwt' });
  useSettingsStore.setState({ serverUrl: 'https://cards.test' });
  jest.mocked(restoreAttachmentFocus).mockClear();
  metadata.mockReset().mockImplementation(async id => ready(id, id === 'image' ? 'image' : 'text'));
  jest.mocked(createApiClient).mockReturnValue({ getAttachmentMetadata: metadata,
    readAttachmentText: jest.fn().mockResolvedValue({ text: '', truncated: false }) } as any);
});
afterEach(() => { useAuthStore.setState({ jwt: null }); });

test('본문 참조 링크는 코드 예시를 제외하고 표시 순서로 수집한다', () => {
  const body = `[첫 파일][a]\n\n![사진](${url('image')})\n\n[둘째](${url('two')})\n\n\`[제외](${url('inline-code')})\`\n\n\`\`\`md\n[제외](${url('code')})\n\`\`\`\n[a]: ${url('one')}`;
  expect(extractCardBodyLinks(body)).toEqual([
    { href: url('one'), label: '첫 파일' }, { href: url('image'), label: '사진' }, { href: url('two'), label: '둘째' },
  ]);
});

test('참조형 요청 링크가 공통 보기 창을 열고 카드 문맥으로 읽힌다', async () => {
  const screen = render(<ContentLinkProvider><AttachmentReadContextProvider context={context}>
    <CardRequestView request={`[첫 파일][a]\n\n[a]: ${url('one')}`} />
  </AttachmentReadContextProvider></ContentLinkProvider>);
  fireEvent.press(screen.getByTestId('body-link'));
  expect(screen.getByTestId('attachment-preview-modal')).toBeTruthy();
  await waitFor(() => expect(metadata).toHaveBeenCalledWith('one', context));
});

test('보고 블록의 이미지와 파일 링크, 접힌 썸네일이 같은 공통 목록을 연다', async () => {
  const detail = { card: cardFixture(), sessions: [], questions: [], comments: [], reports: [{
    id: 'block', cardId: 'card-1', title: '보고', format: 'markdown' as const, createdAt: '',
    body: `![사진](${url('image')})\n\n[파일](${url('one')})`,
  }] };
  const screen = render(<ContentLinkProvider><CardTimeline detail={detail} onChooseAnswer={() => {}} /></ContentLinkProvider>);
  fireEvent.press(screen.getByTestId('card-report-thumbnail-block-0'));
  expect(screen.getByTestId('chat-image-viewer-index').props.children.join('')).toBe('1 / 2');
  await waitFor(() => expect(metadata).toHaveBeenCalledWith('image', context));
  fireEvent.press(screen.getByTestId('chat-image-viewer-close'));
  fireEvent.press(screen.getByTestId('card-fold-report-block'));
  fireEvent.press(screen.getByTestId('body-link'));
  expect(screen.getByTestId('chat-image-viewer-index').props.children.join('')).toBe('2 / 2');
  await waitFor(() => expect(screen.getByText('빈 파일')).toBeTruthy());
});

test('요청 legacy 이미지는 원문 URL을 그대로 쓰고 명시 URL 문맥은 보존한다', () => {
  const screen = render(<AttachmentReadContextProvider context={context}><CardRequestView request={'![사진](/api/attachments/files?nodeId=n&path=%2Fphoto.png)'} /></AttachmentReadContextProvider>);
  const source = screen.getByTestId('card-request-image-0').props.source.uri;
  expect(source).toContain('/api/attachments/files?nodeId=n&path=%2Fphoto.png');
  expect(source).not.toContain('context_type=card');
  screen.rerender(<AttachmentReadContextProvider context={context}><CardRequestView request={'![사진](/api/attachments/files?nodeId=n&path=%2Fphoto.png&context_type=card&context_id=explicit)'} /></AttachmentReadContextProvider>);
  expect(screen.getByTestId('card-request-image-0').props.source.uri).toContain('context_id=explicit');
});

test('채팅 보기 창은 이미지 다음 파일 행의 실제 표시 순서로 넘긴다', () => {
  const image = { key: 'image', name: '사진', previewKind: 'image', readContext: context, mimeType: null, byteSize: null,
    source: { kind: 'ready', attachmentId: 'image', previewUrl: url('image'), originalUrl: url('image') } };
  const missing = { ...image, key: 'missing', name: '결손', source: { kind: 'unavailable', availability: 'missing' } };
  const file = { ...image, key: 'text', name: '파일', previewKind: 'text' };
  const screen = render(<MessageAttachments items={[file, image, missing] as any} role="assistant" />);
  fireEvent.press(screen.getByTestId('message-attachments-images-image-0'));
  expect(screen.UNSAFE_getByType(AttachmentPreviewModal).props.items.map((item: any) => item.key)).toEqual(['image', 'text', 'missing']);
  expect(screen.getByTestId('chat-image-viewer-index').props.children.join('')).toBe('1 / 3');
});

test.each([401, 403, 404, 503, undefined])('메타 조회 실패 %s는 보기 창 안에서 HTTP 상태로 재시도를 고른다', async status => {
  metadata.mockRejectedValue(status === undefined ? new TypeError('offline') : { status });
  const screen = render(<ContentLinkProvider><AttachmentReadContextProvider context={context}>
    <CardRequestView request={`[파일][a]\n[a]: ${url('one')}`} />
  </AttachmentReadContextProvider></ContentLinkProvider>);
  fireEvent.press(screen.getByTestId('body-link'));
  expect(screen.getByTestId('attachment-preview-modal')).toBeTruthy();
  const retryable = status === 503 || status === undefined;
  await waitFor(() => expect(screen.getByText(retryable ? '첨부를 불러오지 못했습니다.' : status === 401 ? '로그인이 필요합니다.' : status === 403 ? '접근 권한이 없습니다.' : '찾을 수 없음')).toBeTruthy());
  if (retryable) {
    metadata.mockResolvedValue(ready('one'));
    fireEvent.press(screen.getByText('다시 시도'));
    await waitFor(() => expect(metadata).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('빈 파일')).toBeTruthy());
  } else expect(screen.queryByText('다시 시도')).toBeNull();
});

test('요청과 커멘트의 본문 이미지도 참조 링크와 같은 블록 보기 목록을 연다', async () => {
  const screen = render(<ContentLinkProvider><AttachmentReadContextProvider context={context}>
    <CardRequestView request={`[첫 파일][a]\n\n![사진](${url('image')})\n\n[a]: ${url('one')}`} />
  </AttachmentReadContextProvider></ContentLinkProvider>);
  fireEvent.press(screen.getByLabelText('사진'));
  expect(screen.getByTestId('chat-image-viewer-index').props.children.join('')).toBe('2 / 2');
  await waitFor(() => expect(metadata).toHaveBeenCalledWith('image', context));
  fireEvent.press(screen.getByTestId('chat-image-viewer-close'));
  expect(restoreAttachmentFocus).toHaveBeenCalledTimes(1);
});
