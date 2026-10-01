import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { render } from '@testing-library/react-native';
import {
  getBottomTabCaptures,
  resetNavigationCapture,
} from './navigationCaptureMock';

const mockRecordFocus = jest.fn();

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
  return { DailyPlannerScreen: ReactModule.forwardRef(() => null) };
});
jest.mock('../../screens/StarredFoldersScreen', () => ({ StarredFoldersScreen: () => null }));
jest.mock('../../screens/ProjectListScreen', () => ({
  ProjectHeaderAddButton: () => null,
  ProjectListScreen: () => null,
}));
jest.mock('../../screens/SessionFeedScreen', () => ({ SessionFeedScreen: () => null }));
jest.mock('../../screens/ChatScreen', () => ({ ChatScreen: () => null }));
jest.mock('../../screens/SettingsScreen', () => ({ SettingsScreen: () => null }));
jest.mock('../../components/planner/FolderWorkspace', () => ({ FolderWorkspace: () => null }));
jest.mock('../phonePanelHistory', () => ({
  PhonePanelHistoryProvider: ({ children }: { children: unknown }) => children,
  usePhonePanelHistory: () => ({
    recordFocus: mockRecordFocus,
    getReturnTab: () => 'FeedTab',
  }),
}));

import { ROOT_TAB_ORDER, TabNavigator } from '../TabNavigator';

beforeEach(() => {
  resetNavigationCapture();
  mockRecordFocus.mockClear();
});

test('ROOT_TAB_ORDER의 모든 phone root screen focus가 같은 history 인스턴스에 route 이름을 기록한다', () => {
  render(<TabNavigator />);
  const screens = getBottomTabCaptures()[0]!.screens;

  expect(screens.map((screen) => screen.name)).toEqual(ROOT_TAB_ORDER);
  for (const screen of screens) {
    expect(screen.listeners?.focus).toEqual(expect.any(Function));
    screen.listeners.focus();
  }

  expect(mockRecordFocus.mock.calls.map(([name]) => name)).toEqual(ROOT_TAB_ORDER);
});

test('push 진입과 제품 ChatBody 마운트 표면을 누락 없이 고정한다', () => {
  const rootNavigator = read('../RootNavigator.tsx');
  expect(rootNavigator).toContain("navigate('ChatTab', {");
  expect(rootNavigator).toContain("screen: 'Chat'");

  expect(findProductFilesContaining(/<ChatBody\b/)).toEqual([
    'components/split/ChatPane.tsx',
    'screens/ChatScreen.tsx',
  ]);
});

test('tablet ChatPane은 이전 panel이 남는 별도 표면이며 기존 우측 닫기 계약을 유지한다', () => {
  const source = read('../../components/split/ChatPane.tsx');

  expect(source).toContain('testID="tablet-chat-close"');
  expect(source).toContain('setActiveSessionId(null)');
});

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');
}

function findProductFilesContaining(pattern: RegExp): string[] {
  const sourceRoot = path.resolve(__dirname, '../..');
  const matches: string[] = [];

  function visit(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') visit(absolute);
        continue;
      }
      if (!entry.name.endsWith('.tsx')) continue;
      if (pattern.test(fs.readFileSync(absolute, 'utf8'))) {
        matches.push(path.relative(sourceRoot, absolute).replaceAll(path.sep, '/'));
      }
    }
  }

  visit(sourceRoot);
  return matches.sort();
}

// These route contracts isolate screen bodies, including the new card detail route.
jest.mock('../../components/planner/CardDetailSheet', () => ({ CardDetailContent: () => null, CardDetailSheet: () => null }));
