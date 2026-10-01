import React, { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { AuthenticatedAppSubtree } from '../AuthenticatedAppSubtree';
import type { PhonePanelHistory } from '../phonePanelHistory';

let mountSerial = 0;
let mockLatestPhoneHistory: PhonePanelHistory | null = null;
let mockHostProps: { onCollectionEnabled?: () => void } | null = null;
const mockRecordCurrentPlannerUsageView = jest.fn();

function mockAuthenticatedProbe({ surface }: { surface: string }) {
  const instance = useRef(++mountSerial).current;
  const [route, setRoute] = useState('root');
  const [draft, setDraft] = useState('');
  return (
    <View>
      <Text testID="surface">{surface}</Text>
      <Text testID="instance">{String(instance)}</Text>
      <Text testID="route">{route}</Text>
      <Text testID="draft">{draft}</Text>
      <Pressable testID="mutate-route" onPress={() => setRoute('task/session-a')} />
      <Pressable testID="mutate-draft" onPress={() => setDraft('prompt+attachment+idempotency')} />
    </View>
  );
}

function mockPhoneHistoryProbe() {
  const ReactModule = require('react');
  const { usePhonePanelHistory } = jest.requireActual('../phonePanelHistory');
  mockLatestPhoneHistory = usePhonePanelHistory();
  return ReactModule.createElement(mockAuthenticatedProbe, { surface: 'phone' });
}

function mockPhoneTabNavigator() {
  const ReactModule = require('react');
  const { PhonePanelHistoryProvider } = jest.requireActual('../phonePanelHistory');
  return ReactModule.createElement(
    PhonePanelHistoryProvider,
    null,
    ReactModule.createElement(mockPhoneHistoryProbe),
  );
}

jest.mock('../TabNavigator', () => ({
  TabNavigator: mockPhoneTabNavigator,
}));
jest.mock('../../components/split/SplitLayout', () => {
  const ReactModule = require('react');
  return {
    SplitLayout: () => ReactModule.createElement(mockAuthenticatedProbe, { surface: 'tablet' }),
  };
});
jest.mock('../../components/UiUsageEventsHost', () => ({
  UiUsageEventsHost: (props: { onCollectionEnabled?: () => void }) => {
    mockHostProps = props;
    return null;
  },
}));
jest.mock('../../lib/planner-folder-workspace', () => ({
  recordCurrentPlannerUsageView: (...args: unknown[]) => mockRecordCurrentPlannerUsageView(...args),
}));

describe('AuthenticatedAppSubtree auth generation boundary', () => {
  beforeEach(() => {
    mountSerial = 0;
    mockLatestPhoneHistory = null;
    mockHostProps = null;
    mockRecordCurrentPlannerUsageView.mockReset();
  });

  test('같은 generation rerender는 보존하고 A→B→A의 각 generation은 route·draft를 새 인스턴스로 교체한다', () => {
    const screen = render(
      <AuthenticatedAppSubtree generation="account-a-1" device="phone" />,
    );
    const firstInstance = screen.getByTestId('instance').props.children;
    fireEvent.press(screen.getByTestId('mutate-route'));
    fireEvent.press(screen.getByTestId('mutate-draft'));
    const firstHistory = mockLatestPhoneHistory!;
    firstHistory.recordFocus('ProjectTab');
    firstHistory.recordFocus('ChatTab');
    expect(firstHistory.getReturnTab()).toBe('ProjectTab');

    screen.rerender(
      <AuthenticatedAppSubtree generation="account-a-1" device="phone" />,
    );
    expect(screen.getByTestId('instance').props.children).toBe(firstInstance);
    expect(screen.getByTestId('route').props.children).toBe('task/session-a');
    expect(screen.getByTestId('draft').props.children).toBe('prompt+attachment+idempotency');
    expect(mockLatestPhoneHistory).toBe(firstHistory);

    screen.rerender(
      <AuthenticatedAppSubtree generation="account-b" device="phone" />,
    );
    const secondInstance = screen.getByTestId('instance').props.children;
    expect(secondInstance).not.toBe(firstInstance);
    expect(screen.getByTestId('route').props.children).toBe('root');
    expect(screen.getByTestId('draft').props.children).toBe('');
    expect(mockLatestPhoneHistory).not.toBe(firstHistory);
    expect(mockLatestPhoneHistory!.getReturnTab()).toBe('FeedTab');

    screen.rerender(
      <AuthenticatedAppSubtree generation="account-a-2" device="tabletLandscape" />,
    );
    expect(screen.getByTestId('instance').props.children).not.toBe(secondInstance);
    expect(screen.getByTestId('surface').props.children).toBe('tablet');
    expect(screen.getByTestId('route').props.children).toBe('root');
  });

  test('수집 가능 스냅샷은 phone navigation 또는 tablet planner 중 한 경로만 고른다', () => {
    const onPhoneUsageEnabled = jest.fn();
    const screen = render(
      <AuthenticatedAppSubtree
        generation="account-a-1"
        device="phone"
        onUiUsageEventsEnabled={onPhoneUsageEnabled}
      />,
    );

    mockHostProps!.onCollectionEnabled?.();
    expect(onPhoneUsageEnabled).toHaveBeenCalledTimes(1);
    expect(mockRecordCurrentPlannerUsageView).not.toHaveBeenCalled();

    screen.rerender(
      <AuthenticatedAppSubtree
        generation="account-a-1"
        device="tabletLandscape"
        onUiUsageEventsEnabled={onPhoneUsageEnabled}
      />,
    );
    mockHostProps!.onCollectionEnabled?.();
    expect(onPhoneUsageEnabled).toHaveBeenCalledTimes(1);
    expect(mockRecordCurrentPlannerUsageView).toHaveBeenCalledTimes(1);
  });
});
