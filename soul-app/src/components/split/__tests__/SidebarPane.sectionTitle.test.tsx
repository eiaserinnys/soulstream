jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
const mockRefreshStarred = jest.fn();
const mockMoveStarredFolderOrder = jest.fn();
const mockStarredFolderListProps = jest.fn();
jest.mock('../../../hooks/usePlannerReads', () => ({
  usePlannerDailyHistory: () => ({ dates: [], loading: false, error: null }),
  usePlannerStarred: () => ({
    data: { items: [], nextCursor: null },
    loading: false,
    error: null,
    loadMore: jest.fn(),
    refresh: mockRefreshStarred,
    refreshRequired: true,
    moveFolderOrder: mockMoveStarredFolderOrder,
    reordering: false,
  }),
}));
jest.mock('../../../hooks/usePlannerActions', () => ({
  usePlannerActions: () => ({ createRootFolder: jest.fn(), createFolder: jest.fn() }),
}));
jest.mock('../../../hooks/usePlannerContextMenus', () => ({
  usePlannerContextMenus: () => ({ openProjectMenu: jest.fn(), openFolderMenu: jest.fn() }),
}));
jest.mock('../../planner/StarredFolderList', () => ({
  StarredFolderList: (props: unknown) => {
    mockStarredFolderListProps(props);
    return null;
  },
}));
jest.mock('../../settings/SettingsModal', () => ({ SettingsModal: () => null }));
jest.mock('../../../lib/planner-folder-workspace', () => ({ openStarredPageWorkspace: jest.fn() }));

import React from 'react';
import { Alert, StyleSheet } from 'react-native';
import { act, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { useSessionStore } from '../../../store/sessionStore';
import { ROOT_SECTION_CONFIG } from '../../../navigation/rootSectionConfig';
import { SidebarPane } from '../SidebarPane';

test('iPad 사이드바 chrome은 단색 시스템 아이콘과 하나의 section-title 역할을 쓴다', () => {
  useSessionStore.setState({ catalog: { folders: [], sessions: {} } });
  const screen = render(<SidebarPane active={false} />);
  const labels = ['카드', '중요 작업', '프로젝트'].map(
    (label) => screen.getByText(label),
  );
  const styles = labels.map((label) => StyleSheet.flatten(label.props.style));
  const header = StyleSheet.flatten(screen.getByTestId('tablet-sidebar-header').props.style);
  const icons = [
    ['sidebar-section-daily-icon', ROOT_SECTION_CONFIG.DailyTab.icon],
    ['sidebar-section-starred-icon', ROOT_SECTION_CONFIG.StarredTab.icon],
    ['sidebar-section-project-icon', ROOT_SECTION_CONFIG.ProjectTab.icon],
  ] as const;

  expect(styles.map(({ fontSize }) => fontSize)).toEqual([18, 18, 18]);
  expect(styles.map(({ lineHeight }) => lineHeight)).toEqual([24, 24, 24]);
  expect(styles.map(({ fontWeight }) => fontWeight)).toEqual(['700', '700', '700']);
  expect(screen.queryByText('📅 데일리')).toBeNull();
  expect(screen.queryByText('⭐ 중요 작업')).toBeNull();
  expect(screen.queryByText('📁 프로젝트')).toBeNull();
  for (const [testID, name] of icons) {
    const icon = screen.getByTestId(testID);
    expect(icon.props.name).toBe(name);
    expect(icon.props.color).toBeTruthy();
  }
  expect(header).toEqual(expect.objectContaining({
    minHeight: 60,
    paddingHorizontal: 20,
    paddingVertical: 6,
    alignItems: 'center',
  }));
});

test('데일리·중요 작업·설정 표면은 같은 20pt 좌우 인셋을 공유한다', () => {
  useSessionStore.setState({ catalog: { folders: [], sessions: {} } });
  const screen = render(<SidebarPane active={false} />);
  const daily = StyleSheet.flatten(screen.getByTestId('sidebar-daily-date-list').props.style);
  const starred = StyleSheet.flatten(screen.getByTestId('sidebar-starred-section').props.style);
  const settings = StyleSheet.flatten(screen.getByTestId('sidebar-settings-footer').props.style);
  const list = StyleSheet.flatten(screen.getByTestId('sidebar-main-list').props.style);

  expect(daily.paddingHorizontal).toBe(20);
  expect(starred.paddingHorizontal).toBe(20);
  expect(settings.paddingHorizontal).toBe(20);
  expect(list.marginTop).toBeLessThan(0);
});

test('사이드바 중요 작업도 공통 순서 변경·오류 안내와 drag scroll lock을 받는다', async () => {
  mockStarredFolderListProps.mockClear();
  mockMoveStarredFolderOrder.mockReset();
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const screen = render(<SidebarPane active />);
  const props = mockStarredFolderListProps.mock.calls.at(-1)?.[0] as {
    onMove?: (sourcePageId: string, beforePageId: string | null) => Promise<void>;
    onRefresh?: () => void;
    refreshRequired?: boolean;
    onDragStateChange?: (dragging: boolean) => void;
    reordering?: boolean;
  };

  expect(props.onMove).toEqual(expect.any(Function));
  expect(props.onRefresh).toBe(mockRefreshStarred);
  expect(props.refreshRequired).toBe(true);
  expect(props.reordering).toBe(false);
  expect(screen.getByTestId('sidebar-main-list').props.scrollEnabled).toBe(true);
  act(() => props.onDragStateChange?.(true));
  expect(screen.getByTestId('sidebar-main-list').props.scrollEnabled).toBe(false);

  mockMoveStarredFolderOrder.mockRejectedValueOnce(new Error('저장 실패'));
  await act(async () => { await props.onMove?.('a', null); });
  expect(mockMoveStarredFolderOrder).toHaveBeenCalledWith('a', null);
  expect(alert).toHaveBeenCalledWith('작업을 완료하지 못했습니다.', '저장 실패');
  alert.mockRestore();
});

test.each([
  [0, 8],
  [34, 22],
])('bottom inset %s에서 설정 버튼만 내부 %spt 보호를 받는다', (
  bottomInset,
  expectedPadding,
) => {
  useSessionStore.setState({ catalog: { folders: [], sessions: {} } });
  const metrics: Metrics = {
    frame: { x: 0, y: 0, width: 1024, height: 1366 },
    insets: { top: 24, bottom: bottomInset, left: 0, right: 0 },
  };
  const screen = render(
    <SafeAreaProvider initialMetrics={metrics}>
      <SidebarPane active={false} />
    </SafeAreaProvider>,
  );

  expect(
    StyleSheet.flatten(screen.getByTestId('sidebar-settings-footer').props.style)
      .paddingBottom,
  ).toBe(expectedPadding);
});
