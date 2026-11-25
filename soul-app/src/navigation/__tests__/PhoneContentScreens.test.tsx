import { render, renderHook } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTokens } from '../../theme';
import { PhoneCardDetail, PhoneMarkdownDocument, PhonePasReportWindow } from '../PhoneContentScreens';

jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
  useFocusEffect: (effect: () => (() => void) | void) => {
    const ReactModule = require('react');
    ReactModule.useEffect(() => effect(), [effect]);
  },
}));
jest.mock('../../components/planner/CardDetailSheet', () => ({ CardDetailContent: () => null }));
jest.mock('../../api/client', () => ({ createApiClient: () => ({}) }));
jest.mock('../phoneSessionNavigation', () => ({ openPhoneChat: jest.fn() }));
jest.mock('../../components/planner/MarkdownDocumentContent', () => ({ MarkdownDocumentContent: () => null }));
const mockBound: { props: any; back: jest.Mock } = { props: null, back: jest.fn(() => false) };
jest.mock('../../components/pasReport/PasReportWindowBound', () => {
  const ReactModule = require('react');
  return { PasReportWindowBound: ReactModule.forwardRef((props: unknown, ref: unknown) => {
    mockBound.props = props;
    ReactModule.useImperativeHandle(ref, () => ({ back: () => mockBound.back() }));
    return null;
  }) };
});
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

describe('PhonePasReportWindow (#1871)', () => {
  function renderWindow() {
    const tabs = { setOptions: jest.fn() };
    let removeListener: ((event: { preventDefault(): void }) => void) | undefined;
    const navigation = {
      getParent: () => tabs,
      getState: () => ({ index: 1, routes: [{ name: 'PersistentSession' }, { name: 'PasReportWindow' }] }),
      addListener: jest.fn((_name: string, listener: (event: { preventDefault(): void }) => void) => { removeListener = listener; return () => {}; }),
      goBack: jest.fn(), navigate: jest.fn(),
    };
    const screen = render(<PhonePasReportWindow route={{ params: { startCardId: 'card-7' } }} navigation={navigation} />);
    return { screen, tabs, navigation, beforeRemove: (event: { preventDefault(): void }) => removeListener?.(event) };
  }
  beforeEach(() => { mockBound.back = jest.fn(() => false); });

  test('시작 안건을 넘기고, 카드 패널 열기는 기존 CardDetail 화면으로 이동한다', () => {
    const { navigation, tabs } = renderWindow();
    expect(mockBound.props.startCardId).toBe('card-7');
    mockBound.props.onOpenCard('card-9');
    expect(navigation.navigate).toHaveBeenCalledWith('CardDetail', { cardId: 'card-9' });
    expect(tabs.setOptions.mock.calls[0][0].tabBarStyle).toMatchObject({ display: 'none' });
  });

  test('뒤로 가기는 창 안에서 열린 것을 닫았으면 화면을 지우지 않고, 닫을 것이 없으면 화면을 닫는다', () => {
    const { beforeRemove } = renderWindow();
    const consumed = { preventDefault: jest.fn() };
    mockBound.back = jest.fn(() => true);
    beforeRemove(consumed);
    expect(consumed.preventDefault).toHaveBeenCalledTimes(1);
    const idle = { preventDefault: jest.fn() };
    mockBound.back = jest.fn(() => false);
    beforeRemove(idle);
    expect(idle.preventDefault).not.toHaveBeenCalled();
  });

  test('닫기 단추는 열린 것이 남아 있어도 한 번에 화면을 닫는다', () => {
    const { navigation, beforeRemove } = renderWindow();
    mockBound.back = jest.fn(() => true);
    mockBound.props.onClose();
    expect(navigation.goBack).toHaveBeenCalledTimes(1);
    const event = { preventDefault: jest.fn() };
    beforeRemove(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
