import React, { useCallback, useRef } from 'react';
import { View } from 'react-native';
import {
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { act, render, waitFor } from '@testing-library/react-native';
import { UiUsageEventsHost } from '../UiUsageEventsHost';
import {
  UI_EVENT_SCHEMA_VERSION,
  UiUsageEvents,
} from '../../lib/ui-usage-events';
import { captureAuthScope, resetAuthScopeForTest } from '../../lib/auth-scope';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useNavigationViewUsageEvents } from '../../navigation/useNavigationViewUsageEvents';

type TestStackParamList = { Feed: undefined };
const Stack = createNativeStackNavigator<TestStackParamList>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => { values.set(key, value); },
    removeItem: async (key: string) => { values.delete(key); },
  };
}

function Harness({
  events,
  onNavigationReady,
}: {
  events: UiUsageEvents;
  onNavigationReady: () => void;
}) {
  const navigationRef = useRef(createNavigationContainerRef<TestStackParamList>()).current;
  const { recordNavigationView, snapshotNavigationView } = useNavigationViewUsageEvents(
    events.record.bind(events),
  );
  const snapshotCurrentView = useCallback(
    () => snapshotNavigationView(navigationRef.getRootState()),
    [navigationRef, snapshotNavigationView],
  );

  return (
    <>
      <UiUsageEventsHost
        generation={captureAuthScope().generation}
        events={events}
        onCollectionEnabled={snapshotCurrentView}
      />
      <NavigationContainer
        ref={navigationRef}
        onReady={() => {
          recordNavigationView(navigationRef.getRootState(), true);
          onNavigationReady();
        }}
      >
        <Stack.Navigator>
          <Stack.Screen name="Feed" component={View} />
        </Stack.Navigator>
      </NavigationContainer>
    </>
  );
}

describe('UiUsageEventsHost navigation wiring', () => {
  beforeEach(() => {
    useSettingsStore.setState({ serverUrl: 'https://collector.test' });
    useAuthStore.setState({
      jwt: 'eyJhbGciOiJub25lIn0.eyJlbWFpbCI6Im93bmVyQGV4YW1wbGUudGVzdCJ9.',
    });
    resetAuthScopeForTest();
  });

  afterEach(() => {
    useAuthStore.setState({ jwt: null });
    useSettingsStore.setState({ serverUrl: '' });
    resetAuthScopeForTest();
  });

  test('config 지연 뒤 현재 navigation 화면을 한 번만 실제 POST 배치에 담는다', async () => {
    const config = deferred<{
      enabled: boolean;
      flushIntervalMs: number;
      maxBatchSize: number;
      maxQueueSize: number;
      schemaVersion: string;
    }>();
    const client = {
      getUiEventsConfig: jest.fn(() => config.promise),
      postUiEvents: jest.fn().mockResolvedValue({ accepted: 2, duplicates: 0, rejected: [] }),
    };
    let serial = 0;
    const events = new UiUsageEvents({
      storage: memoryStorage(),
      createClient: () => client,
      isScopeCurrent: () => true,
      createUuid: () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`,
      autoFlush: false,
    });
    const onNavigationReady = jest.fn();
    const screen = render(<Harness events={events} onNavigationReady={onNavigationReady} />);

    await waitFor(() => expect(onNavigationReady).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(client.getUiEventsConfig).toHaveBeenCalledTimes(1));
    expect(client.postUiEvents).not.toHaveBeenCalled();

    await act(async () => {
      config.resolve({
        enabled: true,
        flushIntervalMs: 10_000,
        maxBatchSize: 20,
        maxQueueSize: 500,
        schemaVersion: UI_EVENT_SCHEMA_VERSION,
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(client.postUiEvents).toHaveBeenCalledTimes(1));
    const batch = client.postUiEvents.mock.calls[0][0];
    expect(batch.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'app_active' }),
      expect.objectContaining({
        type: 'view_open',
        target: { kind: 'view', id: 'Feed' },
        from: null,
        entry: 'auto',
      }),
    ]));
    expect(batch.events.filter((event: { type: string }) => event.type === 'view_open'))
      .toHaveLength(1);
    screen.unmount();
  });
});
