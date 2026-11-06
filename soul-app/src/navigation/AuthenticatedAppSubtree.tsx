import { LayoutContinuityProvider } from './LayoutContinuityContext';
import { AdaptiveNavigationHost } from './AdaptiveNavigationHost';
import React from 'react';
import { PersistentSessionProvider } from './PersistentSessionContext';
import { PersistentSessionStartup } from './PersistentSessionStartup';
import type { DeviceType } from '../theme/useDeviceType';
import { UiUsageEventsHost } from '../components/UiUsageEventsHost';
import { recordCurrentPlannerUsageView } from '../lib/planner-folder-workspace';
import { ContentLinkProvider } from './ContentLinkProvider';

interface Props {
  generation: string;
  device: DeviceType;
  onUiUsageEventsEnabled?: () => void;
  startupReady?: boolean;
  sessionIntent?: boolean;
  onOpenPersistent?: () => void;
  onPersistentLeaveReady?: (leave: (() => void) | null) => void;
  onReportOpenReady?: (open: ((sessionId: string, entryKey: string, onOpen: () => void) => void) | null) => void;
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
  onPersistentLeaveReady,
  onReportOpenReady,
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
        sessionIntent={sessionIntent} onOpenPersistent={onOpenPersistent} onPersistentLeaveReady={onPersistentLeaveReady} onReportOpenReady={onReportOpenReady} />
    </>
  );
}

function AuthenticatedAppInstance({ device, startupReady, sessionIntent, onOpenPersistent, onPersistentLeaveReady, onReportOpenReady }: Pick<Props, 'device' | 'startupReady' | 'sessionIntent' | 'onOpenPersistent' | 'onPersistentLeaveReady' | 'onReportOpenReady'>) {
  return <PersistentSessionProvider sessionIntent={sessionIntent} onLeaveReady={onPersistentLeaveReady} onReportOpenReady={onReportOpenReady}>
    <LayoutContinuityProvider><ContentLinkProvider><AdaptiveNavigationHost device={device} /></ContentLinkProvider></LayoutContinuityProvider>
    {onOpenPersistent ? <PersistentSessionStartup ready={startupReady === true} sessionIntent={sessionIntent === true} onOpen={onOpenPersistent} /> : null}
  </PersistentSessionProvider>;
}
