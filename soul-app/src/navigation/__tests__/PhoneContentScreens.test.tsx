import React from 'react';
import { render, renderHook } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTokens } from '../../theme';
import { PhoneCardDetail, PhoneMarkdownDocument } from '../PhoneContentScreens';

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => (() => void) | void) => {
    const ReactModule = require('react');
    ReactModule.useEffect(() => effect(), [effect]);
  },
}));
jest.mock('../../components/planner/CardDetailSheet', () => ({ CardDetailContent: () => null }));
jest.mock('../../api/client', () => ({ createApiClient: () => ({}) }));
jest.mock('../phoneSessionNavigation', () => ({ openPhoneChat: jest.fn() }));
jest.mock('../../components/planner/MarkdownDocumentContent', () => ({ MarkdownDocumentContent: () => null }));
jest.mock('../../store/settingsStore', () => ({ useSettingsStore: (selector: (state: { serverUrl: string }) => unknown) => selector({ serverUrl: 'https://soulstream.test' }) }));
jest.mock('../../theme', () => ({ useTokens: () => ({ colors: { border: 'border' }, uiSpacing: { md: 12 } }) }));

function SafeAreaInsetsProbe() {
  const insets = useSafeAreaInsets();
  return <Text testID="safe-area-insets">{`${insets.top}:${insets.bottom}`}</Text>;
}

const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
};

test.each(['card', 'document'] as const)('iPhone %s 상세 화면은 안전 영역 뒤로 12 여백을 둔다', (kind) => {
  const t = renderHook(() => useTokens()).result.current;
  const navigation = {
    getParent: () => ({ setOptions: jest.fn() }),
    getState: () => ({ index: 0, routes: [{ name: kind === 'card' ? 'CardDetail' : 'MarkdownDocument' }] }),
    goBack: jest.fn(),
  };
  const screen = render(<SafeAreaProvider initialMetrics={safeAreaMetrics}>
    {kind === 'card'
      ? <PhoneCardDetail route={{ params: { cardId: 'card-1' } }} navigation={navigation} />
      : <PhoneMarkdownDocument route={{ params: { documentId: 'doc-1' } }} navigation={navigation} />}
    <SafeAreaInsetsProbe />
  </SafeAreaProvider>);

  const frame = screen.UNSAFE_getByType(SafeAreaView);
  expect(frame.props.edges).toEqual(['top', 'left', 'right']);
  expect(t.uiSpacing.md).toBe(12);
  expect(StyleSheet.flatten(frame.props.style)).toMatchObject({ flex: 1, paddingTop: t.uiSpacing.md });
  expect(screen.getByTestId('safe-area-insets').props.children).toBe('47:34');
  screen.unmount();
});

function renderPhoneDocument(topRoute: string, routes: Array<{ name: string; params?: Record<string, unknown> }> = []) {
  const tabs = { setOptions: jest.fn() };
  const stackRoutes = routes.length ? routes : [{ name: topRoute }];
  const navigation = {
    getParent: () => tabs,
    getState: () => ({ index: stackRoutes.length - 1, routes: stackRoutes }),
  };
  const screen = render(<PhoneMarkdownDocument
    route={{ params: { documentId: 'doc-1' } }}
    navigation={navigation}
  />);
  return { screen, tabs, stackRoutes };
}

test.each(['CardDetail', 'MarkdownDocument'])('상세 화면에서 %s로 이동하면 이전 화면 정리가 탭 바를 되살리지 않는다', (nextRoute) => {
  const { screen, tabs, stackRoutes } = renderPhoneDocument('MarkdownDocument');
  stackRoutes.push({ name: nextRoute, params: { documentId: 'doc-2' } });

  screen.unmount();

  expect(tabs.setOptions).toHaveBeenCalledTimes(1);
  expect(tabs.setOptions.mock.calls[0][0].tabBarStyle).toMatchObject({ display: 'none' });
});

test('채팅까지 돌아가면 상세 화면 정리가 탭 바를 되살린다', () => {
  const { screen, tabs, stackRoutes } = renderPhoneDocument('MarkdownDocument');
  stackRoutes.push({ name: 'Chat' });

  screen.unmount();

  expect(tabs.setOptions).toHaveBeenLastCalledWith({ tabBarStyle: {
    backgroundColor: 'transparent', borderTopColor: 'border', overflow: 'hidden',
  } });
});
