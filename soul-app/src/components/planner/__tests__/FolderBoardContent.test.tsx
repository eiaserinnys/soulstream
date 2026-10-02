import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

jest.mock('react-native-enriched-markdown', () => {
  const MockReact = require('react');
  const { Text } = require('react-native');
  return {
    EnrichedMarkdownText: ({ markdown }: { markdown: string }) => (
      MockReact.createElement(Text, null, markdown)
    ),
  };
});
jest.mock('react-native-webview', () => {
  const MockReact = require('react');
  const { View } = require('react-native');
  return {
    WebView: (props: any) => MockReact.createElement(View, {
      testID: props.testID,
      accessibilityLabel: props.source.html,
      style: props.style,
    }),
  };
});
jest.mock('../../../hooks/usePlannerFolder', () => ({
  usePlannerFolder: jest.fn(() => ({ data: null, loading: false, error: null })),
}));

import {usePlannerFolder} from '../../../hooks/usePlannerFolder';
import { FolderBoardContent } from '../FolderBoardContent';

test('웹 업무 보드와 같은 markdown, Flux custom_view, asset을 실제 내용으로 렌더한다', async () => {
  const api = {
    getFolderBoardItems: jest.fn().mockResolvedValue([
      { id: 'markdown-card', itemType: 'markdown', itemId: 'doc-1', folderId: 'folder', x: 0, y: 0, metadata: { title: '계획서' } },
      { id: 'flux-card', itemType: 'custom_view', itemId: 'view-1', folderId: 'folder', x: 0, y: 1, metadata: { title: 'Flux 상태판' } },
      { id: 'asset-card', itemType: 'asset', itemId: 'asset-1', folderId: 'folder', x: 0, y: 2, metadata: { originalName: '결과.png', mimeType: 'image/png', byteSize: 2048, signedUrl: 'https://asset.test/result.png' } },
      { id: 'session-card', itemType: 'session', itemId: 'session-1', folderId: 'folder', x: 0, y: 3 },
    ]),
    getMarkdownDocument: jest.fn().mockResolvedValue({ id: 'doc-1', title: '계획서', body: '# 실제 본문', version: 1 }),
    getCustomView: jest.fn().mockResolvedValue({ id: 'view-1', title: 'Flux 상태판', html: '<strong>실제 Flux</strong>', revision: 1 }),
  };
  const screen = render(
    <FolderBoardContent api={api as never} folderId="task-1" />,
  );

  const sectionDisclosure = screen.getByTestId('task-board-disclosure');
  expect(StyleSheet.flatten(sectionDisclosure.props.style)).toMatchObject({ minHeight: 52 });
  expect(StyleSheet.flatten(sectionDisclosure.props.style)).not.toHaveProperty('height');
  expect(screen.queryByText('계획서')).toBeNull();
  fireEvent.press(sectionDisclosure);
  await waitFor(() => expect(screen.getByText('계획서')).toBeTruthy());
  expect(screen.getByText('Flux 상태판')).toBeTruthy();
  expect(screen.getByText('결과.png')).toBeTruthy();
  expect(screen.getByText('📄')).toBeTruthy();
  expect(screen.getByText('▦')).toBeTruthy();
  expect(screen.getByText('📎')).toBeTruthy();
  expect(screen.getByText('image/png · 2.0 KB')).toBeTruthy();
  expect(screen.queryByTestId('task-board-asset-media-asset-card')).toBeNull();
  fireEvent.press(screen.getByTestId('task-board-disclosure-asset-card'));
  expect(screen.getByTestId('task-board-asset-media-asset-card').props.accessibilityLabel)
    .toContain('<img src="https://asset.test/result.png"');
  expect(screen.queryByTestId('task-board-markdown-body')).toBeNull();
  expect(screen.queryByTestId('task-board-custom-view')).toBeNull();
  expect(screen.queryByTestId('task-board-session-session-card')).toBeNull();

  fireEvent.press(screen.getByTestId('task-board-disclosure-markdown-card'));
  await waitFor(() => expect(screen.getByText('# 실제 본문')).toBeTruthy());
  fireEvent.press(screen.getByTestId('task-board-disclosure-flux-card'));
  await waitFor(() => expect(screen.getByTestId('task-board-custom-view')).toBeTruthy());
  expect(screen.getByTestId('task-board-custom-view').props.accessibilityLabel).toContain('실제 Flux');
  expect(StyleSheet.flatten(screen.getByTestId('task-board-custom-view').props.style).width).toBe('100%');
  expect(api.getFolderBoardItems).toHaveBeenCalledWith('task-1');
  expect(usePlannerFolder).toHaveBeenCalledWith(api,'task-1',true,false);
});

test('콜드 스타트 자산에 읽기 URL이 없으면 성공한 척하지 않고 명시적 오류를 표시한다', async () => {
  const api = {
    getFolderBoardItems: jest.fn().mockResolvedValue([
      {
        id: 'asset-card',
        itemType: 'asset',
        itemId: 'asset-1',
        folderId: 'folder',
        x: 0,
        y: 0,
        metadata: {
          originalName: '결과.png',
          mimeType: 'image/png',
          byteSize: 2048,
          storageKey: 'boards/folder/asset-1/result.png',
        },
      },
    ]),
  };
  const screen = render(
    <FolderBoardContent api={api as never} folderId="task-1" />,
  );

  fireEvent.press(screen.getByTestId('task-board-disclosure'));
  await waitFor(() => expect(screen.getByText('결과.png')).toBeTruthy());
  fireEvent.press(screen.getByTestId('task-board-disclosure-asset-card'));

  expect(screen.getByText('파일 주소를 불러오지 못했습니다.')).toBeTruthy();
  expect(screen.queryByTestId('task-board-asset-media-asset-card')).toBeNull();
  expect(screen.queryByText('열기')).toBeNull();
});
