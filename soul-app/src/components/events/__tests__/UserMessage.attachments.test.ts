import {
  extractAttachments,
  resolveAttachmentNodeId,
  buildAttachmentUri,
} from '../UserMessage';
import type { Session, SessionEvent } from '../../../api/types';
import React from 'react';
import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react-native';
import { EventRenderer } from '../EventRenderer';
import { AssistantMessage } from '../AssistantMessage';
import { AttachmentChips } from '../../chat/AttachmentChips';
import { useTokens } from '../../../theme';
import { makeStyles } from '../../chat/ChatBody.styles';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { resetAuthScopeForTest } from '../../../lib/auth-scope';

const mockUseMessageAttachments = jest.fn();
jest.mock('../../../hooks/useMessageAttachments', () => ({
  ...jest.requireActual('../../../hooks/useMessageAttachments'),
  useMessageAttachments: (...args: unknown[]) => mockUseMessageAttachments(...args),
}));

afterEach(() => jest.restoreAllMocks());

/**
 * Phase 2 (atom 260513.02 — chat-inline-attachment): 사용자 발화 말풍선
 * 인라인 첨부 표시 헬퍼 검증.
 */

const ev = (type: string, data: any): SessionEvent => ({
  id: '1',
  type: type as SessionEvent['type'],
  data,
});

const session = (overrides: Partial<Session> = {}): Session => ({
  agentSessionId: 's-1',
  displayName: null,
  status: 'idle',
  createdAt: '2026-05-13T00:00:00Z',
  updatedAt: '2026-05-13T00:00:00Z',
  ...overrides,
});

describe('extractAttachments', () => {
  test('attachments 배열에서 string path만 추출', () => {
    expect(
      extractAttachments(
        ev('user_message', {
          attachments: ['/incoming/s/a.png', '/incoming/s/b.png'],
        }),
      ),
    ).toEqual(['/incoming/s/a.png', '/incoming/s/b.png']);
  });

  test('빈 문자열은 필터링', () => {
    expect(
      extractAttachments(ev('user_message', { attachments: ['/a.png', ''] })),
    ).toEqual(['/a.png']);
  });

  test('attachments 누락 → 빈 배열', () => {
    expect(extractAttachments(ev('user_message', { text: 'hi' }))).toEqual([]);
  });

  test('attachments 비배열(string 등) → 빈 배열', () => {
    expect(
      extractAttachments(ev('user_message', { attachments: '/a.png' })),
    ).toEqual([]);
  });

  test('attachments 배열 안 non-string 필터링', () => {
    expect(
      extractAttachments(
        ev('user_message', { attachments: ['/a.png', 42, null, undefined] as any }),
      ),
    ).toEqual(['/a.png']);
  });
});

describe('resolveAttachmentNodeId', () => {
  test('session.nodeId 우선', () => {
    expect(
      resolveAttachmentNodeId(
        session({ nodeId: 'eias-shopping' }),
        ev('user_message', { node_id: 'event-node' }),
      ),
    ).toBe('eias-shopping');
  });

  test('session.nodeId 없으면 event.data.node_id fallback', () => {
    expect(
      resolveAttachmentNodeId(
        session({}),
        ev('user_message', { node_id: 'event-node' }),
      ),
    ).toBe('event-node');
  });

  test('session 없으면 event.data.node_id fallback', () => {
    expect(
      resolveAttachmentNodeId(undefined, ev('user_message', { node_id: 'evn' })),
    ).toBe('evn');
  });

  test('둘 다 없으면 undefined', () => {
    expect(
      resolveAttachmentNodeId(session({}), ev('user_message', { text: 'x' })),
    ).toBeUndefined();
  });

  test('빈 문자열은 부재로 취급', () => {
    expect(
      resolveAttachmentNodeId(
        session({ nodeId: '' }),
        ev('user_message', { node_id: '' }),
      ),
    ).toBeUndefined();
  });
});

describe('buildAttachmentUri', () => {
  test('정상 인코딩', () => {
    const uri = buildAttachmentUri(
      'https://node.example',
      'eias-shopping',
      '/incoming/sess-1/001 photo.png',
    );
    expect(uri).toBe(
      'https://node.example/api/attachments/files?nodeId=eias-shopping&path=%2Fincoming%2Fsess-1%2F001%20photo.png',
    );
  });

  test('nodeId 없으면 null', () => {
    expect(buildAttachmentUri('https://x', undefined, '/a')).toBeNull();
  });

  test('serverUrl 없으면 null', () => {
    expect(buildAttachmentUri(null, 'n', '/a')).toBeNull();
  });

  test('특수 문자 path 안전하게 인코딩', () => {
    const uri = buildAttachmentUri('https://x', 'n', '/a?b=c&d=e');
    expect(uri).toContain('path=%2Fa%3Fb%3Dc%26d%3De');
  });
});

test.each([
  ['user_message', 'default'], ['user_message', 'manuscript'],
  ['intervention_sent', 'default'], ['intervention_sent', 'manuscript'],
] as const)('%s %s keeps an attachment-only user event in the route session context', (type, presentation) => {
  const event: SessionEvent = { id: '41', type, data: { attachment_ids: ['asset-1'] } };
  mockUseMessageAttachments.mockClear();
  mockUseMessageAttachments.mockReturnValue({
    items: [{
      key: 'asset-1', name: 'photo.png', mimeType: 'image/png', byteSize: 128, previewKind: 'image',
      readContext: { type: 'session', id: 'route-session' },
      source: { kind: 'unavailable', availability: 'unavailable' },
    }],
    retry: jest.fn(),
  });

  const screen = render(React.createElement(EventRenderer, { event, sessionId: 'route-session', presentation }));

  expect(screen.getByTestId('user-message-bubble')).toBeTruthy();
  expect(screen.getByTestId('message-attachments')).toBeTruthy();
  expect(mockUseMessageAttachments).toHaveBeenCalledWith({
    event,
    readContext: { type: 'session', id: 'route-session' },
  });
});

test.each(['default', 'manuscript'] as const)('%s output attachments reuse the assistant content frame', (presentation) => {
  const event: SessionEvent = { id: '42', type: 'assistant_message', data: {
    content: '', attachment_output: true, attachment_ids: ['asset-1'],
  } };
  mockUseMessageAttachments.mockReturnValue({ items: [{
    key: 'asset-1', name: '자료.txt', mimeType: 'text/plain', byteSize: 0, previewKind: 'text',
    readContext: { type: 'session', id: 'route-session' },
    source: { kind: 'unavailable', availability: 'unavailable' },
  }], retry: jest.fn() });
  const screen = render(React.createElement(EventRenderer, { event, sessionId: 'route-session', presentation }));
  expect(screen.UNSAFE_getByType(AssistantMessage).props).toMatchObject({
    event, presentation, attachmentsOnly: true,
  });
  expect(screen.getByTestId('assistant-attachment-content')).toBeTruthy();
  expect(screen.queryByTestId('assistant-message-bubble')).toBeNull();
  expect(screen.getByTestId('message-attachments')).toBeTruthy();
});

test('pending attachment preview trigger and remove trigger stay independent', async () => {
  const tokens = renderHook(() => useTokens()).result.current;
  const onRemove = jest.fn();
  const screen = render(React.createElement(AttachmentChips, {
    attachments: [{ path: '/incoming/photo.png', name: 'photo.png', nodeId: 'node-1',
      originalFile: { uri: 'file:///tmp/photo.png', name: 'photo.png', type: 'image/png' } }],
    styles: makeStyles(tokens), textSecondaryColor: '#000', textMutedColor: '#000',
    onRemove, previewEnabled: true,
  }));

  await act(async () => {
    fireEvent.press(screen.getByTestId('chat-attachment-preview-0'));
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByTestId('attachment-preview-modal')).toBeTruthy());
  expect(onRemove).not.toHaveBeenCalled();

  fireEvent.press(screen.getByTestId('chat-attachment-remove-0'));
  expect(onRemove).toHaveBeenCalledWith(0);
});

test('path-only pending chip uses an authenticated uploader-owned HEAD read', async () => {
  useSettingsStore.setState({ serverUrl: 'https://chat.test' });
  useAuthStore.setState({ jwt: 'preview-jwt' });
  resetAuthScopeForTest();
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'content-disposition': 'inline; filename="archive.bin"',
    'content-length': '16',
    'x-attachment-id': 'asset-archive',
  };
  const fetch = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response);
  const tokens = renderHook(() => useTokens()).result.current;
  const screen = render(React.createElement(AttachmentChips, {
    attachments: [{ path: '/incoming/archive.bin', name: 'archive.bin' }],
    styles: makeStyles(tokens), textSecondaryColor: '#000', textMutedColor: '#000',
    onRemove: jest.fn(), previewEnabled: true, previewNodeId: 'uploader-node',
  }));

  fireEvent.press(screen.getByTestId('chat-attachment-preview-0'));
  await waitFor(() => expect(screen.getByTestId('attachment-preview-modal')).toBeTruthy());
  expect(fetch).toHaveBeenCalledWith(
    'https://chat.test/api/attachments/files?nodeId=uploader-node&path=%2Fincoming%2Farchive.bin',
    expect.objectContaining({ method: 'HEAD' }),
  );
  const init = fetch.mock.calls[0][1] as RequestInit;
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer preview-jwt');
});
