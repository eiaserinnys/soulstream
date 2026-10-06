import React from 'react';
import { TabletNavigator } from './TabletNavigator';
import { PersistentSessionProvider } from './PersistentSessionContext';
import { PersistentSessionStartup } from './PersistentSessionStartup';
import type { DeviceType } from '../theme/useDeviceType';
import { TabNavigator } from './TabNavigator';
import { UiUsageEventsHost } from '../components/UiUsageEventsHost';
import { recordCurrentPlannerUsageView } from '../lib/planner-folder-workspace';

interface Props {
  generation: string;
  device: DeviceType;
  onUiUsageEventsEnabled?: () => void;
  startupReady?: boolean;
  sessionIntent?: boolean;
  onOpenPersistent?: () => void;
}

/**
 * 인증된 UI의 생명주기 경계.
 *
 * opaque auth generation이 바뀌면 key가 달라져 내비게이션 route, iPad overlay,
 * editor/sheet draft, pagination/selection hook을 포함한 전체 하위 트리를 새 인스턴스로
 * 교체한다. 같은 generation의 일반 rerender는 기존 인스턴스를 보존한다.
 */
export function AuthenticatedAppSubtree({
  generation,
  device,
  onUiUsageEventsEnabled,
  startupReady = false,
  sessionIntent = false,
  onOpenPersistent,
}: Props) {
  const snapshotCurrentView = React.useCallback(() => {
    if (device === 'phone') {
      onUiUsageEventsEnabled?.();
      return;
    }
    recordCurrentPlannerUsageView();
  }, [device, onUiUsageEventsEnabled]);

  return (
    <>
      <UiUsageEventsHost generation={generation} onCollectionEnabled={snapshotCurrentView} />
      <AuthenticatedAppInstance key={generation} device={device} startupReady={startupReady}
        sessionIntent={sessionIntent} onOpenPersistent={onOpenPersistent} />
    </>
  );
}

function AuthenticatedAppInstance({ device, startupReady, sessionIntent, onOpenPersistent }: Pick<Props, 'device' | 'startupReady' | 'sessionIntent' | 'onOpenPersistent'>) {
  return <PersistentSessionProvider sessionIntent={sessionIntent}>
    {device === 'phone' ? <TabNavigator /> : <TabletNavigator />}
    {onOpenPersistent ? <PersistentSessionStartup ready={startupReady === true} sessionIntent={sessionIntent === true} onOpen={onOpenPersistent} /> : null}
  </PersistentSessionProvider>;
}
