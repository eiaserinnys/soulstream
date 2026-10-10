import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Image } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AssistantMessage } from '../AssistantMessage';
import { UserMessage } from '../UserMessage';
import { ChatRefinedImageGallery } from '../../AttachmentImage';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';

const serverUrl = 'https://soulstream.eiaserinnys.me';
const firstImage = `${serverUrl}/api/attachments/files?nodeId=eiaserinnys&path=%2Fhome%2Feias%2Fmigration%2Fnetcup-core-bootstrap%2Fprod-state%2Fincoming%2F60668e34-f8b1-4e53-9a8e-c5ff304337e1%2F2026-10-08T15-42-19.069Z-pas247-preview-iphone-light-story-settings-0d5b93a9cf014a8d9a9c76a4d203d60e.png`;
const secondImage = `${serverUrl}/api/attachments/files?nodeId=eiaserinnys&path=%2Fhome%2Feias%2Fmigration%2Fnetcup-core-bootstrap%2Fprod-state%2Fincoming%2F60668e34-f8b1-4e53-9a8e-c5ff304337e1%2F2026-10-08T15-42-19.585Z-pas247-preview-iphone-light-story-settings-fe37869a1a9841dc92f8db2ff4186d61.png`;
const originalFetch = global.fetch;
const fetchMock = jest.fn().mockResolvedValue({ ok: false, headers: { get: () => null } });

beforeEach(() => {
  useSettingsStore.setState({ serverUrl });
  useAuthStore.setState({ jwt: 'component-test-jwt' });
  jest.spyOn(Image, 'getSizeWithHeaders').mockImplementation(() => Promise.resolve({ width: 390, height: 844 }));
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

test('PAS event 8309 keeps both images at their prose positions and opens one two-image viewer', async () => {
  const screen = render(<SafeAreaProvider><AssistantMessage
    presentation="manuscript"
    event={{
      id: '8309',
      type: 'assistant_message',
      data: { text: [
        '링크만 붙였군요. 비교 이미지를 바로 보여드리겠습니다.',
        '',
        '기존 배치',
        '',
        `![기존 폰 배치](${firstImage})`,
        '',
        '변경 시안: ‘세션 스토리’ 버튼을 둘째 줄로 옮깁니다.',
        '',
        `![폰 변경 시안](${secondImage})`,
      ].join('\n') },
    }}
  /></SafeAreaProvider>);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await waitFor(() => expect(Image.getSizeWithHeaders).toHaveBeenCalledWith(
    firstImage,
    { Authorization: 'Bearer component-test-jwt' },
  ));

  expect(screen.getByTestId('assistant-markdown-0').props.markdown).toContain('기존 배치');
  expect(screen.getByTestId('assistant-image-gallery-1-image-0')).toBeTruthy();
  expect(screen.getByTestId('assistant-image-gallery-1-image-0').props.style).toMatchObject({
    width: '100%',
    maxWidth: 200,
    aspectRatio: 1,
    alignSelf: 'flex-start',
  });
  expect(screen.UNSAFE_getAllByType(Image).every((image) => image.props.resizeMode === 'contain')).toBe(true);
  expect(screen.getByTestId('assistant-markdown-2').props.markdown).toContain('변경 시안');
  expect(screen.getByTestId('assistant-image-gallery-3-image-0')).toBeTruthy();

  fireEvent.press(screen.getByTestId('assistant-image-gallery-1-image-0'));
  expect(screen.getByTestId('chat-image-viewer-index').props.children.join('')).toBe('1 / 2');
  expect(screen.getByTestId('chat-image-viewer-image').props.source.uri).toBe(firstImage);
  fireEvent.press(screen.getByTestId('chat-image-viewer-next'));
  expect(screen.getByTestId('chat-image-viewer-index').props.children.join('')).toBe('2 / 2');
  expect(screen.getByTestId('chat-image-viewer-image').props.source.uri).toBe(secondImage);
  fireEvent.press(screen.getByTestId('chat-image-viewer-close'));

  fireEvent.press(screen.getByTestId('assistant-image-gallery-3-image-0'));
  expect(screen.getByTestId('chat-image-viewer-index').props.children.join('')).toBe('2 / 2');
  expect(screen.getByTestId('chat-image-viewer-previous').props.accessibilityState.disabled).toBe(false);
  expect(screen.getByTestId('chat-image-viewer-next').props.accessibilityState.disabled).toBe(true);
});

test('원고형 사용자 메시지는 이미지 첨부만 본문 뒤에 원래 순서로 놓고 함께 탐색한다', async () => {
  const screen = render(<SafeAreaProvider><UserMessage
    presentation="manuscript"
    session={{ nodeId: 'eiaserinnys' }}
    event={{ id: 'structured-images', type: 'user_message', data: {
      text: '첨부 세 장을 확인해주세요.',
      attachments: ['/incoming/first.png', '/incoming/notes.txt', '/incoming/second.webp'],
    } }}
  /></SafeAreaProvider>);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await waitFor(() => expect(Image.getSizeWithHeaders).toHaveBeenCalledWith(
    expect.stringContaining('path=%2Fincoming%2Ffirst.png'),
    { Authorization: 'Bearer component-test-jwt' },
  ));

  const bubbleChildren = React.Children.toArray(
    screen.getByTestId('user-message-bubble').props.children,
  ) as React.ReactElement<{ testID?: string }>[];
  const textIndex = bubbleChildren.findIndex((child) => child.props.testID === 'user-message-text');
  const imageGalleryIndex = bubbleChildren.findIndex((child) => child.props.testID === 'user-chat-image-gallery');
  expect(textIndex).toBeGreaterThanOrEqual(0);
  expect(imageGalleryIndex).toBeGreaterThan(textIndex);
  expect(screen.getByTestId('user-chat-image-gallery-image-0')).toBeTruthy();
  expect(screen.getByTestId('user-chat-image-gallery-image-1')).toBeTruthy();
  expect(screen.getByTestId('user-chat-image-gallery-image-0').props.style).toMatchObject({
    width: '100%',
    maxWidth: 200,
    aspectRatio: 1,
    alignSelf: 'flex-end',
  });

  fireEvent.press(screen.getByTestId('user-chat-image-gallery-image-0'));
  const firstViewedUri = screen.getByTestId('chat-image-viewer-image').props.source.uri;
  expect(firstViewedUri).toContain('path=%2Fincoming%2Ffirst.png');
  fireEvent.press(screen.getByTestId('chat-image-viewer-next'));
  expect(screen.getByTestId('chat-image-viewer-image').props.source.uri).toContain('path=%2Fincoming%2Fsecond.webp');

  const singleUser = render(<SafeAreaProvider><UserMessage
    presentation="manuscript"
    session={{ nodeId: 'eiaserinnys' }}
    event={{ id: 'single-image', type: 'user_message', data: {
      text: '첨부 이미지 하나입니다.',
      attachments: ['/incoming/single.png'],
    } }}
  /></SafeAreaProvider>);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(singleUser.getByTestId('user-chat-image-gallery-image-0').props.style).toMatchObject({
    width: '100%',
    maxWidth: 200,
    aspectRatio: 1,
    alignSelf: 'flex-end',
  });
  expect(singleUser.getByText('single.png').props.style).toMatchObject({
    width: '100%',
    maxWidth: 200,
    alignSelf: 'flex-end',
    textAlign: 'right',
  });
});

test('세 장 gallery는 두 열을 유지하고 원래 viewer 전체 순서로 연다', async () => {
  jest.spyOn(Image, 'getSizeWithHeaders').mockImplementation((uri) => Promise.resolve(
    uri.endsWith('/2.png') ? { width: 900, height: 480 }
      : uri.endsWith('/3.png') ? { width: 300, height: 300 }
        : { width: 390, height: 844 },
  ));
  const viewerImages = [1, 2, 3, 4].map((index) => ({
    source: { uri: `https://chat.test/${index}.png` },
    filename: `${index}.png`,
  }));
  const screen = render(<SafeAreaProvider><ChatRefinedImageGallery
    images={viewerImages.slice(1)}
    viewerImages={viewerImages}
    startIndex={1}
    role="assistant"
    testID="three-image-gallery"
  /></SafeAreaProvider>);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  const firstRow = screen.getByTestId('three-image-gallery-row-0');
  const lastRow = screen.getByTestId('three-image-gallery-row-1');
  const firstCells = React.Children.toArray(firstRow.props.children) as React.ReactElement<{ style?: object }>[];
  const lastCells = React.Children.toArray(lastRow.props.children) as React.ReactElement<{ style?: object }>[];
  expect(firstCells).toHaveLength(2);
  expect(lastCells).toHaveLength(2);
  expect(firstCells.map((cell) => cell.props.style)).toEqual([
    { flexGrow: 1, flexBasis: 0, flexShrink: 1, minWidth: 0 },
    { flexGrow: 1, flexBasis: 0, flexShrink: 1, minWidth: 0 },
  ]);
  expect(lastCells.map((cell) => cell.props.style)).toEqual([
    { flexGrow: 1, flexBasis: 0, flexShrink: 1, minWidth: 0 },
    { flexGrow: 1, flexBasis: 0, flexShrink: 1, minWidth: 0 },
  ]);
  for (const index of [0, 1, 2]) {
    expect(screen.getByTestId('three-image-gallery-image-' + index).props.style).toMatchObject({
      width: '100%',
      maxWidth: 200,
      aspectRatio: 1,
      alignSelf: 'flex-start',
    });
  }
  expect(screen.UNSAFE_getAllByType(Image).every((image) => image.props.resizeMode === 'contain')).toBe(true);
  expect(screen.getByTestId('three-image-gallery-image-2')).toBeTruthy();

  fireEvent.press(screen.getByTestId('three-image-gallery-image-2'));
  expect(screen.getByTestId('chat-image-viewer-index').props.children.join('')).toBe('4 / 4');
  expect(screen.getByTestId('chat-image-viewer-image').props.source.uri).toBe(viewerImages[3].source.uri);
});
