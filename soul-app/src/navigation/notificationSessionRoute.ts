import { openPlannerSessionWorkspace } from '../lib/planner-folder-workspace';
import type { DeviceType } from '../theme/useDeviceType';

/** 푸시 세션 진입을 phone navigation과 iPad workspace overlay로 분기한다. */
export function openNotificationSession(
  device: DeviceType,
  sessionId: string,
  navigatePhone: (sessionId: string) => void,
): void {
  if (device === 'phone') {
    navigatePhone(sessionId);
    return;
  }
  openPlannerSessionWorkspace(sessionId, undefined, undefined, 'notification');
}
