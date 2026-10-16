import React from 'react';
import { StyleSheet, View } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { AttachmentView } from '../../lib/attachment-view';
import { createSessionVisualRoles, useTokens } from '../../theme';
import { renderHook } from '@testing-library/react-native';
import { ChatRefinedImageGallery } from '../AttachmentImage';
import { MessageAttachments } from '../MessageAttachments';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../lib/attachment-image-size', () => ({
  getAttachmentImageSize: jest.fn(() => new Promise(() => {})),
}));

const image = (key: string, name: string): AttachmentView => ({
  key,
  name,
  mimeType: 'image/png',
  byteSize: 1048576,
  previewKind: 'image',
  readContext: { type: 'session', id: 'session-1' },
  source: {
    kind: 'ready',
    attachmentId: key,
    previewUrl: `/api/attachments/${key}/content`,
    originalUrl: `/api/attachments/${key}/content?download=true`,
  },
});

const textFile = (key: string, name: string): AttachmentView => ({
  key,
  name,
  mimeType: 'text/plain',
  byteSize: 0,
  previewKind: 'text',
  readContext: { type: 'session', id: 'session-1' },
  source: {
    kind: 'ready',
    attachmentId: key,
    previewUrl: null,
    originalUrl: `/api/attachments/${key}/content?download=true`,
  },
});

test('image gallery keeps the old role margin unless a following file row needs the shared attachment gap', () => {
  const tokens = renderHook(() => useTokens()).result.current;
  const attachment = createSessionVisualRoles(tokens).chat.attachment;
  const base = {
    images: [{ source: { uri: 'https://app.test/image.png' }, filename: 'image.png' }],
    role: 'user' as const,
    testID: 'image-gallery',
  };

  const followed = render(<ChatRefinedImageGallery {...base} followedByAttachments />);
  expect(StyleSheet.flatten(followed.getByTestId('image-gallery').props.style).marginBottom)
    .toBe(attachment.gridGap);

  const standalone = render(<ChatRefinedImageGallery {...base} followedByAttachments={false} />);
  expect(StyleSheet.flatten(standalone.getByTestId('image-gallery').props.style).marginBottom)
    .toBe(tokens.spacing.lg);

  const legacy = render(<ChatRefinedImageGallery {...base} />);
  expect(StyleSheet.flatten(legacy.getByTestId('image-gallery').props.style).marginBottom)
    .toBe(tokens.spacing.lg);
});

test.each(['user', 'assistant'] as const)('%s legacy gallery margin stays unchanged without the new prop', role => {
  const tokens = renderHook(() => useTokens()).result.current;
  const screen = render(<ChatRefinedImageGallery
    images={[{ source: { uri: 'https://app.test/image.png' }, filename: 'image.png' }]}
    role={role}
    testID="legacy-gallery"
  />);
  const expected = role === 'user' ? tokens.spacing.lg : tokens.uiSpacing.md;
  expect(StyleSheet.flatten(screen.getByTestId('legacy-gallery').props.style).marginBottom).toBe(expected);
});

test('message attachments render image thumbnails before file rows without exposing MIME strings', async () => {
  const items = [image('image-1', 'photo.png'), { ...textFile('text-1', 'notes.txt'), byteSize: 1048576 }, {
    ...textFile('unknown-size', 'unknown.txt'), byteSize: null,
  }];
  const screen = render(<MessageAttachments items={items} role="user" presentation="default" />);

  const gallery = screen.getByTestId('message-attachments-images');
  expect(StyleSheet.flatten(gallery.props.style).marginBottom).toBe(0);
  expect(screen.getByText('photo.png')).toBeTruthy();
  expect(screen.getByText('notes.txt')).toBeTruthy();
  expect(screen.queryByText('image/png')).toBeNull();
  expect(screen.queryByText('text/plain')).toBeNull();
  expect(screen.getByText('1.0 MB')).toBeTruthy();
  expect(screen.queryByText('0 B')).toBeNull();
});

test('a file row opens the shared attachment preview modal', async () => {
  const screen = render(<MessageAttachments items={[textFile('text-1', 'notes.txt')]} role="assistant" />);
  fireEvent.press(screen.getByLabelText('notes.txt 열기'));
  await waitFor(() => expect(screen.getByTestId('attachment-preview-modal')).toBeTruthy());
});

test('mixed attachments share one container gap and one viewer in message order', async () => {
  const tokens = renderHook(() => useTokens()).result.current;
  const items = [image('one', 'one.png'), textFile('text', 'notes.txt'), image('two', 'two.png')];
  const screen = render(<MessageAttachments items={items} role="assistant" />);
  expect(StyleSheet.flatten(screen.getByTestId('message-attachments').props.style).gap).toBe(
    createSessionVisualRoles(tokens).chat.attachment.gridGap,
  );
  fireEvent.press(screen.getByLabelText('notes.txt 열기'));
  await waitFor(() => expect(screen.getByTestId('chat-image-viewer-index').props.children.join('')).toBe('2 / 3'));
  expect(screen.getByText('빈 파일')).toBeTruthy();
  fireEvent.press(screen.getByTestId('chat-image-viewer-next'));
  expect(screen.getByTestId('chat-image-viewer-index').props.children.join('')).toBe('3 / 3');
  const next = screen.getByTestId('chat-image-viewer-next');
  expect(next.props.disabled).not.toBe(true);
  expect(next.props.accessibilityState.disabled).toBe(true);
  fireEvent.press(next);
  expect(screen.getByTestId('chat-image-viewer-index').props.children.join('')).toBe('3 / 3');
  fireEvent.press(screen.getByTestId('chat-image-viewer-previous'));
  fireEvent.press(screen.getByTestId('chat-image-viewer-previous'));
  expect(screen.getByTestId('chat-image-viewer-index').props.children.join('')).toBe('1 / 3');
});
