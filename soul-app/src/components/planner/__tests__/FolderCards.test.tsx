jest.mock('expo-image-picker', () => ({ requestMediaLibraryPermissionsAsync: jest.fn(), launchImageLibraryAsync: jest.fn() }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { cardFixture } from '../../../test-support/cards';
const mockFolder = jest.fn();
jest.mock('../../../hooks/usePlannerFolder', () => ({ usePlannerFolder: (...args: unknown[]) => mockFolder(...args) }));
jest.mock('../CardDetailSheet', () => ({ CardDetailSheet: ({ cardId }: any) => cardId ? require('react').createElement(require('react-native').Text, null, `상세 ${cardId}`) : null }));
jest.mock('../CardAssignmentSheet', () => ({ CardAssignmentSheet: () => null }));
import { FolderCards } from '../FolderCards';

test('같은 카드 행과 상태를 보여주고 탭은 상세, 카드 추가는 입력창을 연다', () => {
  mockFolder.mockReturnValue({ data: { cards: [cardFixture({ status: 'review' }), cardFixture({ id: 'card-2', title: '진행 카드', status: 'running' })] }, loading: false, error: null });
  const screen = render(<FolderCards api={null} folderId="folder-1" />);
  expect(screen.getAllByText('검수')).toHaveLength(1);
  expect(screen.getByText('진행 카드')).toBeTruthy();
  fireEvent.press(screen.getByText('카드 제목'));
  expect(screen.getByText('상세 card-1')).toBeTruthy();
  fireEvent.press(screen.getByText('카드 추가'));
  expect(screen.getByLabelText('맡길 일')).toBeTruthy();
});
