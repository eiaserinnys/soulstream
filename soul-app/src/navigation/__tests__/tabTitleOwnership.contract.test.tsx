import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import {
  getBottomTabCaptures,
  getNativeStackCaptures,
  resetNavigationCapture,
} from './navigationCaptureMock';

const mockSettingsScreen = jest.fn((_props: Record<string, unknown>) => null);
const mockFolderWorkspace = jest.fn((_props: Record<string, unknown>) => null);
const mockOpenDailyReview = jest.fn();
const mockOpenDailyNewFolder = jest.fn();
const mockOpenCardCreate = jest.fn();
const mockCardHomeProps = jest.fn();

jest.mock('@react-navigation/native-stack', () => ({
  createNativeStackNavigator: require('./navigationCaptureMock').createNativeStackNavigatorCapture,
}));
jest.mock('@react-navigation/bottom-tabs', () => ({
  createBottomTabNavigator: require('./navigationCaptureMock').createBottomTabNavigatorCapture,
}));
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../hooks/useSessionsStream', () => ({ useSessionsStream: jest.fn() }));
jest.mock('../../screens/DailyPlannerScreen', () => {
  const ReactModule = require('react');
  return {
    DailyPlannerScreen: ReactModule.forwardRef((_props: unknown, ref: React.Ref<unknown>) => {
      ReactModule.useImperativeHandle(ref, () => ({
        openReview: mockOpenDailyReview,
        openNewFolder: mockOpenDailyNewFolder,
      }));
      return null;
    }),
  };
});
jest.mock('../../screens/StarredFoldersScreen', () => ({ StarredFoldersScreen: () => null }));
jest.mock('../../screens/ProjectListScreen', () => ({
  ProjectHeaderAddButton: () => null,
  ProjectListScreen: () => null,
}));
jest.mock('../../screens/SessionFeedScreen', () => ({ SessionFeedScreen: () => null }));
jest.mock('../../screens/ChatScreen', () => ({ ChatScreen: () => null }));
jest.mock('../../screens/SettingsScreen', () => ({
  SettingsScreen: (props: Record<string, unknown>) => mockSettingsScreen(props),
}));
jest.mock('../../components/planner/FolderWorkspace', () => ({
  FolderWorkspace: (props: Record<string, unknown>) => mockFolderWorkspace(props),
}));

import { ROOT_TAB_ORDER, TabNavigator } from '../TabNavigator';
import { ROOT_SECTION_CONFIG } from '../rootSectionConfig';
import { useSettingsStore } from '../../store/settingsStore';

function renderStackNavigators() {
  render(<TabNavigator />);
  const tabCapture = getBottomTabCaptures()[0];
  expect(tabCapture.screens.map((screen) => screen.name)).toEqual(ROOT_TAB_ORDER);
  for (const screen of tabCapture.screens) {
    render(React.createElement(screen.component));
  }
}

beforeEach(async () => {
  await useSettingsStore.persist.rehydrate();
  resetNavigationCapture();
  mockSettingsScreen.mockClear();
  mockFolderWorkspace.mockClear();
  mockOpenDailyReview.mockClear();
  mockOpenDailyNewFolder.mockClear();
  mockOpenCardCreate.mockClear();
  mockCardHomeProps.mockClear();
  useSettingsStore.setState({ cardIncludeCompleted: {} });
});

test('5개 phone root route는 emoji 없는 shared icon+title을 단독 소유한다', () => {
  renderStackNavigators();
  const stacks = getNativeStackCaptures();
  const roots = stacks.map((capture) => capture.screens[0]);

  expect(roots.map((screen) => [screen.name, screen.options.title])).toEqual([
    ['Daily', '카드'],
    ['FolderList', '폴더'],
    ['Feed', '피드'],
    ['Chat', '챗'],
    ['Settings', '설정'],
  ]);
  for (const [index, root] of roots.entries()) {
    expect(root.options.title).not.toMatch(/[📅⭐📁📰💬⚙️]/u);
    expect(root.options.headerTitle).toEqual(expect.any(Function));
    expect(root.options.headerTitleAlign).toBe('left');
    const section = ROOT_TAB_ORDER[index]!;
    const header = render(React.createElement(root.options.headerTitle));
    expect(header.getByTestId(`root-header-title-${section}`).props.children)
      .toBe(ROOT_SECTION_CONFIG[section].title);
  }
  for (const stack of stacks) {
    expect(stack.navigatorProps?.screenOptions).not.toHaveProperty('headerTitleStyle');
  }

  const tabScreens = getBottomTabCaptures()[0]!.screens;
  for (const screen of tabScreens) {
    const icon = render(React.createElement(screen.options.tabBarIcon, { color: 'red', size: 22 }));
    expect(icon.UNSAFE_getByType('Ionicons' as any).props.name)
      .toBe(ROOT_SECTION_CONFIG[screen.name as keyof typeof ROOT_SECTION_CONFIG].icon);
  }
});

test('phone card home header keeps create and completion actions, daily route remains stored', () => {
  renderStackNavigators();
  const dailyScreen = getNativeStackCaptures()[0]!.screens[0]!;
  const navigation = { setOptions: jest.fn(), navigate: jest.fn() };
  render(React.createElement(dailyScreen.component, { route: { key: 'daily', name: 'Daily' }, navigation }));
  const options = navigation.setOptions.mock.calls.at(-1)?.[0];
  expect(options.headerLeft()).toBeNull();
  const header = render(React.createElement(options.headerRight));
  expect(options.headerTitleAlign).toBe('left');
  expect(mockCardHomeProps).toHaveBeenLastCalledWith(expect.objectContaining({ externalHeader: true }));
  expect(header.getByLabelText('완료·취소 숨김').props.accessibilityState.selected).toBe(true);
  fireEvent.press(header.getByLabelText('드래프트 카드 추가'));
  expect(mockOpenCardCreate).toHaveBeenCalledTimes(1);
  expect(header.queryByLabelText('기존 데일리 기록')).toBeNull();
  expect(header.queryByLabelText('보드 확대')).toBeNull();
  expect(getNativeStackCaptures()[0]!.screens.some((screen) => screen.name === 'DailyHistory')).toBe(true);
});

test('Feed phone root는 native title을 보존하되 large title과 toolbar 검색 통합을 허용하지 않는다', () => {
  renderStackNavigators();
  const feedScreen = getNativeStackCaptures()[2]!.screens[0]!;
  const navigation = { setOptions: jest.fn(), navigate: jest.fn() };
  render(React.createElement(feedScreen.component, {
    route: { key: 'feed', name: 'Feed' },
    navigation,
  }));

  expect(feedScreen.options).toEqual(expect.objectContaining({
    title: '피드',
    headerTitle: expect.any(Function),
  }));
  const options = navigation.setOptions.mock.calls.at(-1)?.[0];
  expect(options).not.toHaveProperty('headerLargeTitleEnabled');
  expect(options.headerSearchBarOptions).toEqual(expect.objectContaining({
    hideWhenScrolling: true,
    placement: 'stacked',
    allowToolbarIntegration: false,
  }));

  const header = render(React.createElement(options.headerRight));
  const search = header.getByLabelText('세션 검색');
  const style = StyleSheet.flatten(search.props.style);
  expect(style.width).toBeGreaterThanOrEqual(44);
  expect(style.height).toBe(style.width);
});

test('긴 한국어 동적 project/task/chat title은 native options.title에 그대로 남는다', () => {
  renderStackNavigators();
  const longProject = '아주 긴 한국어 프로젝트 이름이 말줄임되어야 하는 경우';
  const longFolder = '아주 긴 한국어 업무 이름이 말줄임되어야 하는 경우';
  const projectScreens = getNativeStackCaptures()[1].screens;

  expect(projectScreens).toHaveLength(3);
  expect(projectScreens[2].name).toBe('CardDetail');
  expect(projectScreens[2].options.title).toBe('카드');
  expect(projectScreens[1].options({ route: { params: { folderTitle: longProject } } }).title).toBe(longProject);
  expect(projectScreens[1].options({ route: { params: { folderTitle: longFolder } } }).title).toBe(longFolder);

  const chatSource = read('../../screens/ChatScreen.tsx');
  expect(chatSource).toContain('title: name');
  expect(chatSource).toContain('headerTitle: () => <RootSectionHeaderTitle section="ChatTab" />');
  expect(chatSource).toContain('headerTitle: undefined');
});

test('phone 업무 저장은 body 제목을 복제하지 않고 native route title을 갱신한다', () => {
  renderStackNavigators();
  const folderScreen = getNativeStackCaptures()[1].screens[1];
  const navigation = { setParams: jest.fn(), getParent: jest.fn() };
  render(React.createElement(folderScreen.component, {
    route: {
      key: 'task',
      name: 'FolderWorkspace',
      params: { folderPageId: 'task-1', folderTitle: '기존 제목' },
    },
    navigation,
  }));

  expect(mockFolderWorkspace).toHaveBeenCalledTimes(1);
  const props = mockFolderWorkspace.mock.calls[0][0] as {
    onTitleSaved(title: string): void;
  };
  props.onTitleSaved('새 제목');
  expect(navigation.setParams).toHaveBeenCalledWith({ folderTitle: '새 제목' });
  expect(folderScreen.options({ route: { params: { folderTitle: '새 제목' } } }).title)
    .toBe('새 제목');
});

test('Settings shared workspace owns the header and first connection uses connection-only entry', () => {
  renderStackNavigators();
  const settingsScreen = getNativeStackCaptures()[4].screens[0];
  render(React.createElement(settingsScreen.component, {
    route: { key: 'settings', name: 'Settings' },
    navigation: {},
  }));

  expect(mockSettingsScreen).toHaveBeenLastCalledWith(expect.objectContaining({
    showTitle: false,
    bottomSafeAreaOwner: 'parent',
  }));
  expect(settingsScreen.options.headerShown).toBe(false);
  expect(read('../RootNavigator.tsx')).toContain('<FirstConnectionSettingsScreen />');
  const settingsModal = read('../../components/settings/SettingsModal.tsx');
  expect(settingsModal).toContain('<SettingsScreen');
  expect(settingsModal).toMatch(/<SettingsScreen\b[^>]*\bflattened\b/s);
});

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');
}

// These route contracts isolate screen bodies, including the new card detail route.
jest.mock('../../components/planner/CardDetailSheet', () => ({ CardDetailContent: () => null, CardDetailSheet: () => null }));

jest.mock('../../screens/CardHomeScreen', () => ({ CardHomeScreen: require('react').forwardRef((props: unknown, ref: React.Ref<unknown>) => {
  require('react').useImperativeHandle(ref, () => ({ openCreate: mockOpenCardCreate }));
  mockCardHomeProps(props);
  return null;
}) }));
