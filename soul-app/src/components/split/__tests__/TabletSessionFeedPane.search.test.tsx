jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
const mockSearchProps = jest.fn();
jest.mock('../../../screens/SessionFeedScreen', () => ({ SessionFeedScreen: () => null }));
jest.mock('../../../screens/SearchScreen', () => ({
  SearchScreen: (props: unknown) => { mockSearchProps(props); return null; },
}));

import { fireEvent, render } from '@testing-library/react-native';
import { useSearchStore } from '../../../store/searchStore';
import { TabletSessionFeedPane } from '../TabletSessionFeedPane';

beforeEach(() => {
  mockSearchProps.mockClear();
  useSearchStore.getState().closeTabletSearch();
});

test('세로 피드 머리의 세션 검색 단추는 아이폰 피드 머리처럼 검색을 열고 입력에 초점을 준다', () => {
  const screen = render(<TabletSessionFeedPane searchEntry />);

  fireEvent.press(screen.getByLabelText('세션 검색'));

  expect(useSearchStore.getState().tabletActive).toBe(true);
  expect(mockSearchProps).toHaveBeenLastCalledWith(expect.objectContaining({ showInput: true, autoFocus: true }));
  expect(screen.queryByLabelText('세션 검색')).toBeNull();
  expect(screen.getByLabelText('검색 닫기')).toBeTruthy();
});

test('다른 검색 입구가 있는 피드 칸에는 세션 검색 단추를 두지 않는다', () => {
  const screen = render(<TabletSessionFeedPane />);

  expect(screen.queryByLabelText('세션 검색')).toBeNull();
});
