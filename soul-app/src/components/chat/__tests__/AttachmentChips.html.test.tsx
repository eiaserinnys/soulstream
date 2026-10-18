import React from 'react';
import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react-native';
import { useTokens } from '../../../theme';
import { AttachmentChips } from '../AttachmentChips';
import { makeStyles } from '../ChatBody.styles';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { resetAuthScopeForTest } from '../../../lib/auth-scope';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

jest.mock('expo-file-system', () => ({
  File: jest.fn().mockImplementation((uri: string) => {
    const bytes = new TextEncoder().encode(
      uri.includes('.html') ? '<h1>로컬 문서</h1>' : '평문 본문',
    );
    return {
      exists: true,
      size: bytes.byteLength,
      type: uri.includes('.html') ? 'text/html' : null,
      open: () => ({ readBytes: (maximum: number) => bytes.subarray(0, maximum), close: jest.fn() }),
    };
  }),
}));

afterEach(() => {
  jest.restoreAllMocks();
  useSettingsStore.setState({ serverUrl: '' });
  useAuthStore.setState({ jwt: null });
});

function chipScreen(attachments: Parameters<typeof AttachmentChips>[0]['attachments'], previewNodeId?: string) {
  const tokens = renderHook(() => useTokens()).result.current;
  return render(<AttachmentChips
    attachments={attachments}
    styles={makeStyles(tokens)} textSecondaryColor="#000" textMutedColor="#000"
    onRemove={jest.fn()} previewEnabled previewNodeId={previewNodeId}
  />);
}

test('path-only HTML chip drops the HEAD size and reads the document body from the original files URL', async () => {
  useSettingsStore.setState({ serverUrl: 'https://chat.test' });
  useAuthStore.setState({ jwt: 'preview-jwt' });
  resetAuthScopeForTest();
  const fetch = jest.spyOn(global, 'fetch').mockImplementation((_input, init) => {
    if ((init as RequestInit | undefined)?.method === 'HEAD') {
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: (name: string) => {
          const key = name.toLowerCase();
          if (key === 'content-type') return 'text/html';
          if (key === 'content-disposition') return 'inline; filename="report.html"';
          if (key === 'content-length') return '0';
          return null;
        } },
      } as unknown as Response);
    }
    return Promise.resolve({
      ok: true, status: 200, headers: { get: () => null },
      text: async () => '<h1>원문 문서</h1>',
    } as unknown as Response);
  });
  const screen = chipScreen([{ path: '/incoming/report.html', name: 'report.html' }], 'uploader-node');

  fireEvent.press(screen.getByTestId('chat-attachment-preview-0'));
  await waitFor(() => expect(screen.getByTestId('attachment-preview-html')).toBeTruthy());
  expect(screen.getByTestId('attachment-preview-html').props.accessibilityLabel).toContain('원문 문서');
  expect(fetch).toHaveBeenCalledWith(
    'https://chat.test/api/attachments/files?nodeId=uploader-node&path=%2Fincoming%2Freport.html',
    expect.objectContaining({ method: 'HEAD' }));
  const bodyCall = fetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method !== 'HEAD')!;
  expect(bodyCall[0]).toContain('/api/attachments/files?');
  expect(new Headers((bodyCall[1] as RequestInit).headers).get('range')).toBe('bytes=0-1048575');
  expect(new Headers((bodyCall[1] as RequestInit).headers).get('authorization')).toBe('Bearer preview-jwt');
});

test('local HTML chip reads the bounded local body and renders it as a document instead of raw text', async () => {
  resetAuthScopeForTest();
  const fetch = jest.spyOn(global, 'fetch');
  const screen = chipScreen([{ path: '/incoming/report.html', name: 'report.html',
    originalFile: { uri: 'file:///tmp/report.html', name: 'report.html', type: '' } }]);

  fireEvent.press(screen.getByTestId('chat-attachment-preview-0'));
  await waitFor(() => expect(screen.getByTestId('attachment-preview-html')).toBeTruthy());
  expect(screen.getByTestId('attachment-preview-html').props.accessibilityLabel).toContain('로컬 문서');
  expect(screen.queryByTestId('attachment-preview-text')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

test('local plain-text chip keeps the plain text reader', async () => {
  resetAuthScopeForTest();
  const screen = chipScreen([{ path: '/incoming/note.txt', name: 'note.txt',
    originalFile: { uri: 'file:///tmp/note.txt', name: 'note.txt', type: 'text/plain' } }]);

  await act(async () => { fireEvent.press(screen.getByTestId('chat-attachment-preview-0')); });
  await waitFor(() => expect(screen.getByTestId('attachment-preview-text')).toBeTruthy());
  expect(screen.queryByTestId('attachment-preview-html')).toBeNull();
});
