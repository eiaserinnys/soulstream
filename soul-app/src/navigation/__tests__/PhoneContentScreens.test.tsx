import React from 'react';
import { render } from '@testing-library/react-native';
import { PhoneMarkdownDocument } from '../PhoneContentScreens';

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => (() => void) | void) => {
    const ReactModule = require('react');
    ReactModule.useEffect(() => effect(), [effect]);
  },
}));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('../../components/planner/CardDetailSheet', () => ({ CardDetailContent: () => null }));
jest.mock('../../api/client', () => ({ createApiClient: () => ({}) }));
jest.mock('../phoneSessionNavigation', () => ({ openPhoneChat: jest.fn() }));
jest.mock('../../components/planner/MarkdownDocumentContent', () => ({ MarkdownDocumentContent: () => null }));
jest.mock('../../store/settingsStore', () => ({ useSettingsStore: (selector: (state: { serverUrl: string }) => unknown) => selector({ serverUrl: 'https://soulstream.test' }) }));
jest.mock('../../theme', () => ({ useTokens: () => ({ colors: { border: 'border' } }) }));

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
