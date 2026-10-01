import { usePlannerStore } from '../../store/plannerStore';
import { useUIStore } from '../../store/uiStore';
import { openNotificationSession } from '../notificationSessionRoute';

beforeEach(() => {
  usePlannerStore.getState().resetForTest();
  useUIStore.setState({
    selectedFolderPageId: null,
    folderOverlayVisible: false,
    activeSessionId: null,
    focusEventId: null,
  });
});

test.each(['tabletPortrait', 'tabletLandscape'] as const)(
  '%s 푸시는 iPad 세션 오버레이를 연다',
  (device) => {
    const navigatePhone = jest.fn();

    openNotificationSession(device, 'session-push', navigatePhone);

    expect(navigatePhone).not.toHaveBeenCalled();
    expect(useUIStore.getState()).toMatchObject({
      selectedFolderPageId: null,
      folderOverlayVisible: true,
      activeSessionId: 'session-push',
    });
  },
);

test('phone 푸시는 기존 ChatTab navigation만 사용한다', () => {
  const navigatePhone = jest.fn();

  openNotificationSession('phone', 'session-push', navigatePhone);

  expect(navigatePhone).toHaveBeenCalledWith('session-push');
  expect(useUIStore.getState().folderOverlayVisible).toBe(false);
});
