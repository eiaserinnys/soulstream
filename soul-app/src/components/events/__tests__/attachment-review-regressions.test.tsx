import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { EventRenderer } from '../EventRenderer';
import { ContentLinkProvider } from '../../../navigation/ContentLinkProvider';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { resetAuthScopeForTest } from '../../../lib/auth-scope';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('react-native-enriched-markdown', () => {
  const React = require('react'); const { Text } = require('react-native');
  return { EnrichedMarkdownText: (props: any) => React.createElement(Text, { ...props, testID: 'body-markdown' }, props.markdown) };
});

const descriptor = { attachment_id: 'A', name: '빈 첨부.txt', mime_type: 'text/plain', byte_size: 0,
  checksum_sha256: null, width: null, height: null, preview_kind: 'text', preview_mime_type: 'text/plain' };
function response(body: unknown, status = 200): Response {
  return { ok: status < 400, status, statusText: '', json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }) } as Response;
}
const projection = { event_id: 41, items: [{ kind: 'asset', descriptor,
  read_context: { type: 'session', id: 'route-session' }, legacy_sources: [] }] };
const user = { id: '41', type: 'user_message' as const, data: { text: '본문', attachment_ids: ['A'] } };
beforeEach(() => {
  useSettingsStore.setState({ serverUrl: 'https://chat.test' });
  useAuthStore.setState({ jwt: 'test-jwt' }); resetAuthScopeForTest();
});
afterEach(() => jest.restoreAllMocks());

test('503 renders a short status and retry recovers the same attachment', async () => {
  const fetch = jest.spyOn(global, 'fetch').mockResolvedValueOnce(response({}, 503)).mockResolvedValue(response(projection));
  const screen = render(<EventRenderer event={user} sessionId="route-session" />);
  await waitFor(() => expect(screen.getByText('다시 시도')).toBeTruthy());
  expect(screen.queryByText('사용할 수 없음')).toBeNull();
  fireEvent.press(screen.getByText('다시 시도'));
  await waitFor(() => expect(screen.getByText('빈 첨부.txt')).toBeTruthy());
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('a denied path-only durable read never renders an unscoped files image', async () => {
  const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(response({}, 403));
  const screen = render(<EventRenderer event={{ ...user, data: { text: '본문', attachments: ['/incoming/a.png'], node_id: 'node' } }} sessionId="route-session" />);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  const sources = screen.UNSAFE_queryAllByType(Image).map(image => image.props.source?.uri).filter(Boolean);
  expect(sources.some(uri => uri.includes('/api/attachments/files'))).toBe(false);
  expect(screen.queryByText('다시 시도')).toBeNull();
});

test.each(['/api/attachments/A/content', '/api/attachments/files?nodeId=node&path=%2Fincoming%2Fa.txt'])(
  'markdown link %s reads through the route session context', async href => {
    const fetch = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/files')) return { ok: true, status: 200,
        headers: new Headers({ 'content-type': 'application/octet-stream', 'content-length': '0',
          'content-disposition': 'inline; filename="legacy.txt"' }) } as Response;
      return response({ descriptor, upload_status: 'committed' });
    });
    const screen = render(<ContentLinkProvider><EventRenderer event={{ id: '2', type: 'assistant_message', data: { content: `[파일](${href})` } }} sessionId="route-session" /></ContentLinkProvider>);
    await act(async () => { fireEvent(screen.getByTestId('body-markdown'), 'linkPress', { url: href }); });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(String(fetch.mock.calls[0][0])).toContain('context_type=session');
    expect(String(fetch.mock.calls[0][0])).toContain('context_id=route-session');
    await waitFor(() => expect(screen.getByTestId('attachment-preview-modal')).toBeTruthy());
  },
);

test.each(['default', 'manuscript'] as const)('%s attachment bubble reserves shared width and puts attachments after body', async presentation => {
  jest.spyOn(global, 'fetch').mockResolvedValue(response(projection));
  const screen = render(<EventRenderer event={user} sessionId="route-session" presentation={presentation} />);
  await waitFor(() => expect(screen.getByText('빈 첨부.txt')).toBeTruthy());
  const bubble = screen.getByTestId('user-message-bubble');
  const row = screen.UNSAFE_getAllByType(View).find(node => {
    const style = StyleSheet.flatten(node.props.style);
    return style?.flexDirection === 'row' && style.justifyContent === 'flex-end';
  })!;
  fireEvent(row, 'layout', { nativeEvent: { layout: { width: 358, height: 200 } } });
  expect(StyleSheet.flatten(bubble.props.style).minWidth).toBeGreaterThan(250);
  const children = React.Children.toArray(bubble.props.children) as React.ReactElement<any>[];
  expect(children.findIndex(child => child.props.testID === 'user-message-text')).toBeLessThan(
    children.findIndex(child => child.props.testID === 'user-message-attachments'));
});

test.each(['default', 'manuscript'] as const)('%s phone body-to-attachment spacing equals the attachment grid gap', async presentation => {
  jest.spyOn(require('react-native'), 'useWindowDimensions').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
  jest.spyOn(global, 'fetch').mockResolvedValue(response(projection));
  const screen = render(<EventRenderer event={user} sessionId="route-session" presentation={presentation} />);
  await waitFor(() => expect(screen.getByText('빈 첨부.txt')).toBeTruthy());
  expect(StyleSheet.flatten(screen.getByTestId('user-message-attachments').props.style).marginTop).toBe(
    StyleSheet.flatten(screen.getByTestId('message-attachments').props.style).gap);
});

test.each([310, 352])('PAS reserves min(320, row width %s) without imposing the normal bubble maximum', async width => {
  jest.spyOn(global, 'fetch').mockResolvedValue(response(projection));
  const screen = render(<EventRenderer event={user} sessionId="route-session" presentation="manuscript" />);
  await waitFor(() => expect(screen.getByText('빈 첨부.txt')).toBeTruthy());
  const row = screen.UNSAFE_getAllByType(View).find(node => StyleSheet.flatten(node.props.style)?.justifyContent === 'flex-end')!;
  fireEvent(row, 'layout', { nativeEvent: { layout: { width, height: 200 } } });
  const style = StyleSheet.flatten(screen.getByTestId('user-message-bubble').props.style);
  expect(style.minWidth).toBe(Math.min(320, width));
  expect(style.maxWidth).toBeUndefined();
});
