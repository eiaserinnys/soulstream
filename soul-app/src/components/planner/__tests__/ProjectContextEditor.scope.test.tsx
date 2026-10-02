import { useDraftStore } from '../../../store/draftStore';
import { Alert } from 'react-native';
import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { ProjectContextEditor } from '../ProjectContextEditor';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { resetAuthScopeForTest } from '../../../lib/auth-scope';

let mockPageDetail: any;
const mockSaveProjectContext = jest.fn().mockResolvedValue(undefined);

jest.mock('../../../hooks/usePlannerReads', () => ({
  usePlannerPageDetail: () => mockPageDetail,
}));
jest.mock('../../../hooks/usePlannerActions', () => ({
  usePlannerActions: () => ({ saveProjectContext: mockSaveProjectContext }),
}));

beforeEach(() => {
  useSettingsStore.setState({ serverUrl: 'https://planner.test' });
  useAuthStore.setState({ jwt: 'scope-a' });
  resetAuthScopeForTest();
  mockPageDetail = {
    data: {
      blocks: [{
        id: 'description', pageId: 'project-page', parentId: null,
        positionKey: 'a', blockType: 'paragraph', text: 'A 계정 컨텍스트',
        properties: {}, collapsed: false,
      }],
    },
    loading: false,
    error: null,
  };
  mockSaveProjectContext.mockClear();
});

test('편집 중 auth generation이 바뀌면 text·saved·server draft를 모두 비운다', async () => {
  const screen = render(
    <ProjectContextEditor api={null} projectPageId="project-page" active />,
  );
  fireEvent.press(screen.getByText('편집'));
  const input = screen.getByPlaceholderText('이 프로젝트의 공통 지침');
  expect(input.props.value).toBe('A 계정 컨텍스트');
  fireEvent.changeText(input, 'A 계정 미저장 draft');

  mockPageDetail = { data: undefined, loading: true, error: null };
  await act(async () => {
    useAuthStore.getState().setJwt('scope-b');
    await Promise.resolve();
  });

  expect(screen.queryByPlaceholderText('이 프로젝트의 공통 지침')).toBeNull();
  expect(mockSaveProjectContext).not.toHaveBeenCalled();
});

test('긴 지침은 읽기 상태에서 8줄로 접고 편집 때만 TextInput을 만든다', () => {
  const guidance = Array.from({ length: 30 }, (_, index) => `지침 ${index + 1}`).join('\n');
  mockPageDetail = { data: { blocks: [{
    id: 'description', pageId: 'project-page', parentId: null,
    positionKey: 'a', blockType: 'paragraph', text: guidance,
    properties: {}, collapsed: false,
  }] }, loading: false, error: null };
  const screen = render(<ProjectContextEditor api={null} projectPageId="project-page" active />);
  expect(screen.queryByPlaceholderText('이 프로젝트의 공통 지침')).toBeNull();
  const readText = screen.getByTestId('folder-context-read-text');
  expect(readText.props.numberOfLines).toBe(8);
  const readStyle = StyleSheet.flatten(readText.props.style);
  expect(readStyle.color).toBeTruthy();
  expect(readStyle.color).not.toBe('transparent');
  expect(readStyle.opacity).toBeUndefined();
  const glass = screen.getByTestId('folder-context-glass');
  const foreground = screen.getByTestId('folder-context-foreground');
  expect(StyleSheet.flatten(glass.props.style).position).toBe('absolute');
  expect(StyleSheet.flatten(foreground.props.style).zIndex).toBeGreaterThan(
    StyleSheet.flatten(glass.props.style).zIndex ?? 0,
  );
  expect(foreground.findAllByType(readText.type).includes(readText)).toBe(true);
  fireEvent.press(screen.getByText('펼치기'));
  expect(foreground.findAllByType(readText.type).includes(screen.getByText('접기'))).toBe(true);
  expect(screen.getByTestId('folder-context-read-text').props.numberOfLines).toBeUndefined();
  fireEvent.press(screen.getByText('접기'));
  expect(screen.getByTestId('folder-context-read-text').props.numberOfLines).toBe(8);
  fireEvent.press(screen.getByText('편집'));
  expect(screen.getByPlaceholderText('이 프로젝트의 공통 지침').props.value).toBe(guidance);
});

test('프로젝트 지침 초안은 닫기·실패 뒤 복원되고 저장 성공 뒤 제거된다', async () => {
  await useAuthStore.persist.rehydrate(); await useSettingsStore.persist.rehydrate(); await useDraftStore.persist.rehydrate();
  useAuthStore.setState({ jwt: `header.${Buffer.from(JSON.stringify({ email: 'project@example.com' })).toString('base64url')}.signature` });
  useDraftStore.setState({ drafts: {} });
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockSaveProjectContext.mockRejectedValueOnce(new Error('연결 실패')).mockResolvedValue(undefined);
  const screen = render(<ProjectContextEditor api={null} projectPageId="project-page" active />);
  fireEvent.press(screen.getByText('편집'));
  fireEvent.changeText(screen.getByPlaceholderText('이 프로젝트의 공통 지침'), '영속 지침 초안');
  await act(async () => fireEvent.press(screen.getByText('컨텍스트 저장')));
  expect(Object.values(useDraftStore.getState().drafts)).toContain('영속 지침 초안');
  screen.unmount();
  const reopened = render(<ProjectContextEditor api={null} projectPageId="project-page" active />);
  fireEvent.press(reopened.getByText('편집'));
  expect(reopened.getByDisplayValue('영속 지침 초안')).toBeTruthy();
  await act(async () => fireEvent.press(reopened.getByText('컨텍스트 저장')));
  expect(useDraftStore.getState().drafts).toEqual({});
  expect(mockSaveProjectContext).toHaveBeenLastCalledWith('project-page', '영속 지침 초안');
  jest.restoreAllMocks();
});
