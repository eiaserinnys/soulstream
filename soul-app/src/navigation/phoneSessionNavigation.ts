import { Alert } from 'react-native';
import { useSearchStore } from '../store/searchStore';
import { resolvePlannerSessionFolder } from '../lib/planner-folder-workspace';
import type { PhoneReturnTab } from './phonePanelHistory';

type ParentTabNavigator = {
  navigate: (...args: any[]) => void;
};

export type PhoneRootNavigation = ParentTabNavigator;

export type PhoneStackNavigation = {
  getParent: () => ParentTabNavigator | undefined;
};

let latestSearchOpenRequest = 0;

/** Invalidate a root session-link open while its linked-task lookup is pending. */
export function cancelPhoneSearchSessionOpen(): void {
  latestSearchOpenRequest += 1;
}

/** 폰 stack에서 한 단계 위 root tab을 통해 채팅 세션을 연다. */
export function openPhoneChat(
  navigation: PhoneStackNavigation,
  sessionId: string,
  focusEventId?: number,
  storyOpenRequestId?: number,
): boolean {
  latestSearchOpenRequest += 1;
  const tabs = navigation.getParent();
  if (!tabs) return false;
  useSearchStore.getState().rememberSession(sessionId);
  tabs.navigate('ChatTab', {
    screen: 'Chat',
    params: {
      sessionId,
      ...(focusEventId === undefined ? {} : { focusEventId }),
      ...(storyOpenRequestId === undefined ? {} : { storyOpenRequestId }),
    },
  });
  return true;
}

/** Keep the resolved task on the Folder stack, then open the exact chat result. */
export async function openPhoneSearchSession(
  navigation: PhoneStackNavigation,
  sessionId: string,
  focusEventId?: number,
  storyOpenRequestId?: number,
  onResolutionFailure?: () => void,
): Promise<boolean> {
  const requestId = ++latestSearchOpenRequest;
  const tabs = navigation.getParent();
  if (!tabs) return false;
  try {
    const folder = await resolvePlannerSessionFolder(sessionId);
    if (requestId !== latestSearchOpenRequest) return false;
    if (folder) {
      tabs.navigate('FolderTab', {
        screen: 'FolderWorkspace',
        params: {
          folderPageId: folder.page.id,
          folderTitle: folder.page.title,
        },
      });
    }
  } catch {
    if (requestId !== latestSearchOpenRequest) return false;
    if (onResolutionFailure) {
      onResolutionFailure();
    } else {
      Alert.alert(
        '폴더 연결을 확인하지 못했습니다',
        '세션을 열지 않았습니다. 잠시 후 다시 시도해 주세요.',
      );
    }
    return false;
  }
  return openPhoneChat(navigation, sessionId, focusEventId, storyOpenRequestId);
}

export function openPhoneSearchSessionFromRoot(
  navigation: PhoneRootNavigation,
  sessionId: string,
  focusEventId?: number,
  onResolutionFailure?: () => void,
): Promise<boolean> {
  return openPhoneSearchSession(
    { getParent: () => navigation },
    sessionId,
    focusEventId,
    undefined,
    onResolutionFailure,
  );
}

/** 검색은 새 탭이 아니라 피드 stack 안의 전용 화면으로 연다. */
export function openPhoneSearch(
  navigation: PhoneStackNavigation,
  initialQuery?: string,
): boolean {
  const tabs = navigation.getParent();
  if (!tabs) return false;
  tabs.navigate('FeedTab', {
    screen: 'Search',
    params: initialQuery ? { initialQuery } : undefined,
  });
  return true;
}

/** 세션 미선택 채팅 화면에서 root 피드 탭으로 돌아간다. */
export function openPhoneFeed(navigation: PhoneStackNavigation): boolean {
  const tabs = navigation.getParent();
  if (!tabs) return false;
  tabs.navigate('FeedTab');
  return true;
}

/** 채팅을 열기 직전에 포커스되어 있던 phone root tab으로 돌아간다. */
export function openPreviousPhonePanel(
  navigation: PhoneStackNavigation,
  returnTab: PhoneReturnTab,
): boolean {
  const tabs = navigation.getParent();
  if (!tabs) return false;
  tabs.navigate(returnTab);
  return true;
}
