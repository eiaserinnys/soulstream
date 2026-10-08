import React from 'react';
import { Image, Modal, StyleSheet } from 'react-native';
import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react-native';
import { useTokens } from '../../theme';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { ImageViewerModal } from '../ImageViewerModal';
import { AttachmentImage } from '../AttachmentImage';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

test('full-screen image modal owns its safe area outside the header and scrolling image', () => {
  const onClose = jest.fn();
  const screen = render(<ImageViewerModal sources={[{ uri: 'https://test/photo.png' }]} initialIndex={0} onClose={onClose} />);
  const modal = screen.UNSAFE_getByType(Modal);
  expect(modal.props.children.type).toBe(SafeAreaProvider);
  expect(modal.props.children.props.initialMetrics).toBeUndefined();
  expect(modal.props.children.props.children.type).toBe(SafeAreaView);
  expect(modal.props).toMatchObject({ transparent: true, presentationStyle: 'overFullScreen', onRequestClose: onClose });
  fireEvent.press(screen.getByLabelText('이미지 닫기'));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('closing an attachment leaves its original thumbnail available', () => {
  const screen = render(<AttachmentImage source={{ uri: 'https://test/photo.png' }} accessibilityLabel="첨부 사진" />);
  fireEvent.press(screen.getByLabelText('첨부 사진'));
  expect(screen.getByTestId('image-viewer-pages')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('이미지 닫기'));
  expect(screen.queryByTestId('image-viewer-pages')).toBeNull();
  expect(screen.getByLabelText('첨부 사진')).toBeTruthy();
});

test('캡션은 해당 이미지 페이지 아래에만 나타나고 기본 첨부는 그대로다', () => {
  const t = renderHook(() => useTokens()).result.current;
  const screen = render(<AttachmentImage source={{ uri: 'https://test/one.png' }}
    sources={[{ uri: 'https://test/one.png' }, { uri: 'https://test/two.png' }]}
    captions={['첫 화면', '둘째 화면']} accessibilityLabel="첫 화면 썸네일" />);
  expect(screen.queryByText('첫 화면')).toBeNull();
  fireEvent.press(screen.getByLabelText('첫 화면 썸네일'));
  expect(screen.getByTestId('image-viewer-caption-0').props.children).toBe('첫 화면');
  expect(screen.getByTestId('image-viewer-caption-1').props.children).toBe('둘째 화면');
  expect(StyleSheet.flatten(screen.getByTestId('image-viewer-caption-0').props.style)).toMatchObject({
    backgroundColor: t.colors.surface, textAlign: 'center', padding: t.spacing.md,
  });
});

test('원본 비율 확인 전에는 작은 로딩 상태를 쓰고 측정 실패도 작은 오류로 접는다', async () => {
  let resolveSize!: (size: { width: number; height: number }) => void;
  const source = { uri: 'https://chat.test/one.png', headers: { Authorization: 'Bearer image-test-token' } };
  const getSizeWithHeaders = jest.spyOn(Image, 'getSizeWithHeaders');
  getSizeWithHeaders.mockImplementation(() => new Promise((resolve) => { resolveSize = resolve; }));
  const t = renderHook(() => useTokens()).result.current;
  const screen = render(<SafeAreaProvider><AttachmentImage
    source={source} accessibilityLabel="첫 이미지 크게 보기" variant="chatRefined" testID="loading-chat-image"
  /></SafeAreaProvider>);

  expect(screen.getByTestId('chat-image-loading')).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByTestId('loading-chat-image').props.style)).toMatchObject({
    minHeight: t.foundation.minHeight.secondary,
  });
  expect(StyleSheet.flatten(screen.getByTestId('loading-chat-image').props.style).aspectRatio).toBeUndefined();
  expect(screen.UNSAFE_queryByType(Image)).toBeNull();

  await act(async () => {
    resolveSize({ width: 390, height: 844 });
    await Promise.resolve();
  });
  expect(StyleSheet.flatten(screen.getByTestId('loading-chat-image').props.style).aspectRatio).toBe(390 / 844);
  expect(screen.UNSAFE_getByType(Image).props.source).toBe(source);

  getSizeWithHeaders.mockImplementation(() => Promise.reject(new Error('unauthorized')));
  const failed = render(<SafeAreaProvider><AttachmentImage
    source={source} accessibilityLabel="실패한 이미지" variant="chatRefined" testID="failed-chat-image"
  /></SafeAreaProvider>);
  await waitFor(() => expect(failed.getByText('이미지를 불러오지 못했습니다.')).toBeTruthy());
  expect(StyleSheet.flatten(failed.getByTestId('failed-chat-image').props.style)).toMatchObject({
    minHeight: t.foundation.minHeight.secondary,
  });
  expect(failed.UNSAFE_queryByType(Image)).toBeNull();
});

test('원고형 첨부는 실제 종횡비를 유지하고 같은 메시지의 이전·다음·닫기를 제공한다', async () => {
  const sources = [
    { uri: 'https://chat.test/one.png', headers: { Authorization: 'Bearer image-test-token' } },
    { uri: 'https://chat.test/two.png', headers: { Authorization: 'Bearer image-test-token' } },
  ];
  const getSizeWithHeaders = jest.spyOn(Image, 'getSizeWithHeaders');
  getSizeWithHeaders.mockImplementation(() => Promise.resolve({ width: 390, height: 844 }));
  global.fetch = jest.fn().mockResolvedValue({ ok: false, headers: { get: () => null } }) as unknown as typeof fetch;
  const screen = render(<SafeAreaProvider initialMetrics={{
    frame: { x: 0, y: 0, width: 390, height: 844 },
    insets: { top: 47, right: 0, bottom: 34, left: 0 },
  }}><AttachmentImage
    source={sources[0]}
    sources={sources}
    accessibilityLabel="첫 이미지 크게 보기"
    filename="one.png"
    filenames={['one.png', 'two.png']}
    alts={['첫 이미지', '둘째 이미지']}
    variant="chatRefined"
    testID="chat-image-thumb"
  /></SafeAreaProvider>);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  await waitFor(() => expect(getSizeWithHeaders).toHaveBeenCalledWith(sources[0].uri, sources[0].headers));
  expect(StyleSheet.flatten(screen.getByTestId('chat-image-thumb').props.style).aspectRatio).toBe(390 / 844);

  fireEvent.press(screen.getByTestId('chat-image-thumb'));
  const modal = screen.UNSAFE_getByType(Modal);
  expect(modal.props.children.type).toBe(SafeAreaProvider);
  const modalProviderChild = modal.props.children.props.children;
  expect(modalProviderChild.type.name).toBe('ChatRefinedImageViewerContent');
  expect(screen.UNSAFE_getByType(SafeAreaView).props.edges).toEqual(['top', 'bottom', 'left', 'right']);
  expect(screen.getByTestId('chat-image-viewer-image').props.source).toBe(sources[0]);
  expect(screen.getByTestId('chat-image-viewer-previous').props.accessibilityState.disabled).toBe(true);
  expect(screen.getByTestId('chat-image-viewer-next').props.accessibilityState.disabled).toBe(false);
  fireEvent.press(screen.getByTestId('chat-image-viewer-next'));
  expect(screen.getByTestId('chat-image-viewer-index').props.children.join('')).toBe('2 / 2');
  expect(screen.getByTestId('chat-image-viewer-image').props.source).toBe(sources[1]);
  expect(screen.getByTestId('chat-image-viewer-next').props.accessibilityState.disabled).toBe(true);
  fireEvent.press(screen.getByTestId('chat-image-viewer-previous'));
  expect(screen.getByTestId('chat-image-viewer-image').props.source).toBe(sources[0]);
  fireEvent.press(screen.getByTestId('chat-image-viewer-close'));
  expect(screen.queryByTestId('chat-image-viewer-surface')).toBeNull();
  expect(screen.getByTestId('chat-image-thumb')).toBeTruthy();

  const oneImage = render(<SafeAreaProvider><AttachmentImage
    source={sources[0]} sources={[sources[0]]} accessibilityLabel="단일 이미지 크게 보기"
    variant="chatRefined" testID="single-chat-image"
  /></SafeAreaProvider>);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  fireEvent.press(oneImage.getByTestId('single-chat-image'));
  expect(oneImage.queryByTestId('chat-image-viewer-previous')).toBeNull();
  expect(oneImage.queryByTestId('chat-image-viewer-next')).toBeNull();
});
