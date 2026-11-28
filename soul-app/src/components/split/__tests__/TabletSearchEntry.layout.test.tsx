jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
const mockFeedProps = jest.fn();
jest.mock('../SidebarPane', () => ({ SidebarPane: () => null }));
jest.mock('../MainListPane', () => ({ MainListPane: () => null }));
jest.mock('../TabletSessionFeedPane', () => ({
  TabletSessionFeedPane: (props: unknown) => { mockFeedProps(props); return null; },
}));
jest.mock('../../planner/FolderWorkspaceReadOverlay', () => ({ FolderWorkspaceReadOverlay: () => null }));
jest.mock('../../planner/TodayCardComposer', () => ({ TodayCardComposer: () => null }));
import { render } from '@testing-library/react-native';
import { ThreePaneLayout } from '../ThreePaneLayout';
import { TwoPaneWithDrawer } from '../TwoPaneWithDrawer';
import { useUIStore } from '../../../store/uiStore';

const base = {
  mainPaneViews: { global: 'board' }, folderOverlayVisible: false, settingsVisible: false,
  cardBoardExpanded: false, floatingComposerBottomInset: 0,
};

beforeEach(() => mockFeedProps.mockClear());

test('세로 2단은 카드 화면에서만 피드 머리에 세션 검색 입구를 둔다', () => {
  useUIStore.setState({ ...base, activeSection: { kind: 'daily', date: '2026-10-03' } } as any);
  const screen = render(<TwoPaneWithDrawer />);
  expect(mockFeedProps).toHaveBeenLastCalledWith(expect.objectContaining({ searchEntry: true }));

  mockFeedProps.mockClear();
  useUIStore.setState({ activeSection: { kind: 'project', folderId: 'folder-1', projectPageId: 'page-1' } } as any);
  screen.rerender(<TwoPaneWithDrawer />);
  expect(mockFeedProps).toHaveBeenLastCalledWith(expect.objectContaining({ searchEntry: false }));
});

test('가로 3단은 사이드바 검색칸이 입구라 피드 머리에 단추를 두지 않는다', () => {
  useUIStore.setState({ ...base, activeSection: { kind: 'daily', date: '2026-10-03' } } as any);
  render(<ThreePaneLayout />);
  expect(mockFeedProps.mock.calls.every(([props]) => !(props as { searchEntry?: boolean })?.searchEntry)).toBe(true);
});
