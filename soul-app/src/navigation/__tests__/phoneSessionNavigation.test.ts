import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import {
  openPhoneChat,
  openPhoneFeed,
  openPreviousPhonePanel,
} from '../phoneSessionNavigation';
import { PhoneSessionFeedScreen } from '../TabNavigator';

jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useIsFocused: () => true,
}));

jest.mock('@expo/vector-icons/Ionicons', () => () => null);

jest.mock('../../screens/DailyPlannerScreen', () => ({ DailyPlannerScreen: () => null }));
jest.mock('../../screens/StarredFoldersScreen', () => ({ StarredFoldersScreen: () => null }));
jest.mock('../../screens/ProjectListScreen', () => ({ ProjectListScreen: () => null }));
jest.mock('../../screens/ChatScreen', () => ({ ChatScreen: () => null }));
jest.mock('../../screens/SettingsScreen', () => ({ SettingsScreen: () => null }));
jest.mock('../../components/planner/FolderWorkspace', () => ({ FolderWorkspace: () => null }));

jest.mock('../../screens/SessionFeedScreen', () => {
  const ReactModule = require('react');
  const { TouchableOpacity } = require('react-native');
  return {
    SessionFeedScreen: ({ onOpenSession }: { onOpenSession: (sessionId: string) => void }) => (
      ReactModule.createElement(TouchableOpacity, {
        testID: 'mock-session-feed-open',
        onPress: () => onOpenSession('session-1'),
      })
    ),
  };
});

describe('phone session navigation', () => {
  test('현재 stack의 부모 tab에서 ChatTab.Chat으로 이동한다', () => {
    const navigate = jest.fn();
    const getParent = jest.fn(() => ({ navigate }));

    expect(openPhoneChat({ getParent }, 'session-1')).toBe(true);
    expect(getParent).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('ChatTab', {
      screen: 'Chat',
      params: { sessionId: 'session-1' },
    });
  });

  test('Chat stack의 부모 tab에서 FeedTab으로 이동한다', () => {
    const navigate = jest.fn();
    const getParent = jest.fn(() => ({ navigate }));

    expect(openPhoneFeed({ getParent })).toBe(true);
    expect(getParent).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('FeedTab');
  });

  test('지연 조회된 직전 root tab으로 이동하고 parent가 없으면 명시적으로 실패한다', () => {
    const navigate = jest.fn();

    expect(openPreviousPhonePanel({ getParent: () => ({ navigate }) }, 'ProjectTab')).toBe(true);
    expect(navigate).toHaveBeenCalledWith('ProjectTab');
    expect(openPreviousPhonePanel({ getParent: () => undefined }, 'FeedTab')).toBe(false);
  });

  test('피드와 데일리·별표·프로젝트 업무가 같은 ChatTab 경로를 공유한다', () => {
    const source = read('../TabNavigator.tsx');
    expect(source.match(/openPhoneChat\(navigation, sessionId\)/g)).toHaveLength(2);
    expect(source).not.toContain("getParent()?.getParent()?.navigate('ChatTab'");
  });

  test('폰 피드 화면에서 세션을 누르면 실제로 ChatTab.Chat에 도달한다', () => {
    const navigate = jest.fn();
    const screen = render(
      React.createElement(PhoneSessionFeedScreen, {
        navigation: { getParent: () => ({ navigate }) } as any,
        route: { key: 'feed', name: 'Feed' } as any,
      }),
    );

    fireEvent.press(screen.getByTestId('mock-session-feed-open'));

    expect(navigate).toHaveBeenCalledWith('ChatTab', {
      screen: 'Chat',
      params: { sessionId: 'session-1' },
    });
  });

  test('폰 채팅 빈 상태는 왼쪽 패널을 언급하지 않고 피드 복귀 동작을 제공한다', () => {
    const source = read('../../screens/ChatScreen.tsx');
    expect(source).toContain('피드에서 세션을 선택하세요');
    expect(source).toContain('openPhoneFeed(navigation)');
    expect(source).toContain('headerLeft: undefined');
    expect(source).toContain('headerRight: undefined');
    expect(source).not.toContain('<ChatBody sessionId={undefined} />');
  });
});

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');
}

// These route contracts isolate screen bodies, including the new card detail route.
jest.mock('../../components/planner/CardDetailSheet', () => ({ CardDetailContent: () => null, CardDetailSheet: () => null }));
