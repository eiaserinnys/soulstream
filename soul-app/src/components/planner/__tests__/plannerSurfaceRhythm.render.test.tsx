jest.mock('expo-image-picker', () => ({ requestMediaLibraryPermissionsAsync: jest.fn(), launchImageLibraryAsync: jest.fn() }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
let mockDeviceType: 'phone' | 'tabletPortrait' = 'phone';
const mockUsePlannerFolder = jest.fn();

jest.mock('../../../theme', () => ({
  ...jest.requireActual('../../../theme'),
  useDeviceType: () => mockDeviceType,
}));
jest.mock('../../../theme/useDeviceType', () => ({
  useDeviceType: () => mockDeviceType,
  deviceTypeToBaseKey: (device: string) => device === 'phone' ? 'phone' : 'tablet',
}));
jest.mock('react-native-enriched-markdown', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    EnrichedMarkdownText: ({ markdown, testID }: { markdown: string; testID?: string }) => (
      React.createElement(Text, { testID }, markdown)
    ),
  };
});
jest.mock('react-native-webview', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { WebView: (props: any) => React.createElement(View, props) };
});
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../../hooks/usePlannerFolder', () => ({
  usePlannerFolder: (...args: unknown[]) => mockUsePlannerFolder(...args),
}));

import { PixelRatio, StyleSheet } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { resetAuthScopeForTest } from '../../../lib/auth-scope';
import { useAuthStore } from '../../../store/authStore';
import { TabletMarkdownEditor } from '../TabletMarkdownEditor';
import { FolderBoardContent } from '../FolderBoardContent';
import { FolderCards } from '../FolderCards';
import { cardFixture } from '../../../test-support/cards';
// Updates left by the last step (VirtualizedList cell batches, debounce timers, mocked native
// promises) must settle inside act before RNTL's cleanup yields to the event loop.
const settleTimers = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });

beforeEach(() => {
  mockDeviceType = 'phone';
  jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(1);
  useAuthStore.setState({ jwt: 'planner-rhythm' });
  resetAuthScopeForTest();
  mockUsePlannerFolder.mockReset().mockReturnValue({ data: null, loading: false, error: null });
});
afterEach(() => jest.restoreAllMocks());

test('iPad fontScale2 TabletMarkdownEditor는 memo112·action48을 고정 height 없이 확장한다', () => {
  mockDeviceType = 'tabletPortrait';
  jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(2);
  const screen = render(
    <TabletMarkdownEditor
      testID="rhythm-editor"
      value="서버 본문"
      draft="변경 본문"
      onChangeDraft={jest.fn()}
      onSave={jest.fn()}
      onCancel={jest.fn()}
      emptyText="본문 없음"
    />,
  );
  fireEvent.press(screen.getByTestId('rhythm-editor-edit-action'));

  assertNaturalMinHeight(screen.getByTestId('rhythm-editor-input'), 112);
  assertNaturalMinHeight(screen.getByTestId('rhythm-editor-save-action'), 48);
  expect(screen.getByTestId('rhythm-editor-input').props.allowFontScaling).not.toBe(false);
});

test.each([
  ['phone', 1, 44],
  ['tabletPortrait', 2, 48],
] as const)(
  '%s fontScale%s Board·Cards는 row64·icon24·action%i를 실제 렌더한다',
  async (device, fontScale, actionSize) => {
    mockDeviceType = device;
    jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(fontScale);
    mockUsePlannerFolder.mockReturnValue({
      data: {
        folder: { id: 'task-1', name: '업무', archived: false, version: 1 },
        cards: [cardFixture({ folderId: 'task-1', title: '검증' })],
      },
      loading: false,
      error: null,
    });
    const api = {
      getFolderBoardItems: jest.fn().mockResolvedValue([{
        id: 'markdown-card', itemType: 'markdown', itemId: 'doc-1',
        folderId: 'folder', x: 0, y: 0, metadata: { title: '계획서' },
      }]),
    };
    const screen = render(
      <>
        <FolderBoardContent api={api as never} folderId="task-1" />
        <FolderCards api={null} folderId="task-1" />
      </>,
    );

    assertNaturalMinHeight(screen.getByTestId('task-board-disclosure'), 52);
    fireEvent.press(screen.getByTestId('task-board-disclosure'));
    await waitFor(() => expect(screen.getByText('계획서')).toBeTruthy());
    assertNaturalMinHeight(screen.getByTestId('task-board-disclosure-markdown-card'), 64);
    expect(StyleSheet.flatten(
      screen.getByTestId('task-board-icon-markdown-card').props.style,
    )).toMatchObject({ width: 24, height: 24 });
    expect(StyleSheet.flatten(
      screen.getByTestId('task-board-disclosure-frame-markdown-card').props.style,
    )).toMatchObject({ width: actionSize, height: actionSize });

    expect(screen.getByText('검증')).toBeTruthy();
    expect(StyleSheet.flatten(screen.getByLabelText('카드 추가').props.style))
      .toMatchObject({ minHeight: actionSize, height: actionSize, width: actionSize });
    const cardRow = screen.getByTestId('card-row-card-1');
    expect(cardRow.findAll((node) => StyleSheet.flatten(node.props.style)?.minHeight === 112).length).toBeGreaterThan(0);
    await settleTimers();
  },
);

function assertNaturalMinHeight(node: { props: { style?: unknown } }, expected: number) {
  const style = StyleSheet.flatten(node.props.style);
  expect(style).toMatchObject({ minHeight: expected });
  expect(style).not.toHaveProperty('height');
}
