import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { FolderListScreen } from '../FolderListScreen';

const mockFolder = { folderId: 'starred-folder', page: { id: 'starred-page', title: '중요 폴더' } };
const mockProject = { id: 'project-folder', name: '전체 폴더' };
jest.mock('../StarredFoldersScreen', () => { const { TouchableOpacity, Text } = require('react-native'); return { StarredFoldersScreen: (props: any) => (
  <TouchableOpacity testID="existing-starred-list" accessibilityState={{ disabled: !props.active }} onPress={() => props.onOpenFolder(mockFolder)}><Text>중요 폴더</Text></TouchableOpacity>
) }; });
jest.mock('../ProjectListScreen', () => { const { TouchableOpacity, Text } = require('react-native'); return { ProjectListScreen: (props: any) => (
  <TouchableOpacity testID="existing-project-list" onPress={() => props.onOpenProject(mockProject, 'project-page')}><Text>프로젝트 목록</Text></TouchableOpacity>
) }; });

test('중요 작업으로 시작하고 기존 두 목록의 폴더 진입을 그대로 전달한다', () => {
  const onOpenFolder = jest.fn();
  const onOpenProject = jest.fn();
  const onTabChange = jest.fn();
  const screen = render(<FolderListScreen onOpenFolder={onOpenFolder} onOpenProject={onOpenProject} onTabChange={onTabChange} />);
  expect(screen.getByLabelText('중요 작업').props.accessibilityState.selected).toBe(true);
  expect(onTabChange).toHaveBeenLastCalledWith('starred');
  fireEvent.press(screen.getByTestId('existing-starred-list'));
  expect(onOpenFolder).toHaveBeenCalledWith(mockFolder);
  const starred = screen.getByTestId('existing-starred-list');
  fireEvent.press(screen.getByLabelText('전체 폴더'));
  expect(screen.getByLabelText('전체 폴더').props.accessibilityState.selected).toBe(true);
  expect(onTabChange).toHaveBeenLastCalledWith('all');
  fireEvent.press(screen.getByTestId('existing-project-list'));
  expect(onOpenProject).toHaveBeenCalledWith(mockProject, 'project-page');
  fireEvent.press(screen.getByLabelText('중요 작업'));
  expect(screen.getByTestId('existing-starred-list')).toBe(starred);
});

test('비활성 폴더 화면에서는 중요 목록의 자동 갱신을 중지한다', () => {
  const screen = render(<FolderListScreen active={false} />);
  expect(screen.getByTestId('existing-starred-list').props.accessibilityState.disabled).toBe(true);
});
