import { StackActions } from '@react-navigation/native';
import type { ImageURISource } from 'react-native';
import {
  classifyInternalLink,
  type InternalLinkTarget,
} from '../../../packages/soul-ui/src/lib/internal-link';
import type { ApiClient } from '../api/client';
import type { AttachmentReadContext } from '../../../packages/wire-schema/src/attachments';
import { plannerFolderDetailToSummary } from '../api/plannerTypes';
import { cardAttachmentUrl } from './card-attachments';
import { cardImageSource } from './card-image-source';
import { isLegacyAttachmentImage, type AttachmentView } from './attachment-view';
import { attachmentLinkView, parseExactAttachmentLink, type AttachmentLink } from './attachment-link-view';
import {
  openPlannerFolderWorkspace,
  openPlannerSessionWorkspace,
  openStarredPageWorkspace,
} from './planner-folder-workspace';
import { openPhoneSearchSession } from '../navigation/phoneSessionNavigation';
import { openTabletSessionFromRoot } from '../navigation/tabletSessionNavigation';
import { useUIStore } from '../store/uiStore';
import type { DeviceType } from '../theme/useDeviceType';

type ContentLinkApi = Pick<ApiClient,
  'getPlannerFolder' | 'getPage' | 'getAttachmentMetadata' | 'readLegacyAttachmentText'>;

export interface ContentLinkNavigation {
  push?: (name: string, params?: Record<string, unknown>) => void;
  getParent?: () => { navigate?: (name: string, params?: Record<string, unknown>) => void } | undefined;
  getState?: () => { index?: number; routes?: Array<{ name?: string; params?: Record<string, unknown> }> };
  dispatch?: (action: unknown) => void;
  popTo?: (name: string) => void;
}

export interface OpenContentLinkNavigationArgs {
  href: string;
  serverUrl: string;
  jwt: string | null;
  api: ContentLinkApi | null;
  navigation: ContentLinkNavigation | null;
  device: DeviceType;
  activeSessionId?: string | null;
  leavePersistent?: () => void;
  openImage?: (source: ImageURISource) => void;
  openAttachment?: (view: AttachmentView, items?: readonly AttachmentView[], initialIndex?: number) => void;
  attachmentLinks?: readonly AttachmentLink[];
  attachmentLabel?: string;
  readContext?: AttachmentReadContext;
  openExternal: (href: string) => Promise<unknown> | void;
  alert: (message: string) => void;
}

function failureMessage(target: InternalLinkTarget): string | null {
  switch (target.kind) {
    case 'session': return '세션을 열지 못했습니다.';
    case 'card': return '카드를 열지 못했습니다.';
    case 'document': return null;
    case 'folder': return '폴더를 열지 못했습니다.';
    case 'page': return '페이지를 열지 못했습니다.';
    case 'attachment_asset': return '첨부를 열지 못했습니다.';
    case 'attachment': return '이미지를 열지 못했습니다.';
  }
}

function isTabletMain(navigation: ContentLinkNavigation): boolean {
  const state = navigation.getState?.();
  const index = state?.index ?? ((state?.routes?.length ?? 0) - 1);
  return state?.routes?.[index]?.name === 'Main';
}

function openPhoneFolder(
  navigation: ContentLinkNavigation,
  folderPageId: string,
  folderTitle: string,
  folderId?: string,
): boolean {
  const tabs = navigation.getParent?.();
  if (!tabs?.navigate) return false;
  tabs.navigate('FolderTab', {
    screen: 'FolderWorkspace',
    params: { folderPageId, folderTitle, ...(folderId === undefined ? {} : { folderId }) },
  });
  return true;
}

function returnTabletToMain(
  navigation: ContentLinkNavigation,
  leavePersistent?: () => void,
): boolean {
  leavePersistent?.();
  if (navigation.popTo) {
    navigation.popTo('Main');
    return true;
  }
  if (navigation.dispatch) {
    navigation.dispatch(StackActions.popTo('Main'));
    return true;
  }
  return false;
}

function alertForMissingNavigation(
  alert: (message: string) => void,
  target: InternalLinkTarget,
): void {
  const message = failureMessage(target);
  if (message) alert(message);
}

function isSameTopRouteTarget(
  navigation: ContentLinkNavigation,
  routeName: string,
  paramName: string,
  targetId: string,
): boolean {
  const state = navigation.getState?.();
  const index = state?.index ?? ((state?.routes?.length ?? 0) - 1);
  const topRoute = state?.routes?.[index];
  return topRoute?.name === routeName && topRoute.params?.[paramName] === targetId;
}

function alertUnlessUnauthorized(
  alert: (message: string) => void,
  target: InternalLinkTarget,
  error: unknown,
): void {
  if ((error as { status?: number } | null)?.status !== 401) {
    alertForMissingNavigation(alert, target);
  }
}

/** Resolve and open an internal content target using the current navigator. */
export async function openContentLinkNavigation({
  href,
  serverUrl,
  jwt,
  api,
  navigation,
  device,
  activeSessionId,
  leavePersistent,
  openImage,
  openAttachment,
  readContext,
  attachmentLinks,
  attachmentLabel,
  openExternal,
  alert,
}: OpenContentLinkNavigationArgs): Promise<void> {
  const absoluteHref = serverUrl ? new URL(href, serverUrl).href : href;
  const attachmentLink = serverUrl ? parseExactAttachmentLink(href, serverUrl) : null;

  if (attachmentLink?.kind === 'invalid') {
    alert('첨부를 열 수 없습니다.');
    return;
  }
  if (attachmentLink?.kind === 'id' || attachmentLink?.kind === 'legacy') {
    const options = { serverUrl, jwt, api, readContext };
    const selected = attachmentLinkView({ href, label: attachmentLabel ?? '' }, options);
    if (selected && openAttachment) {
      const links = attachmentLinks?.length ? attachmentLinks : [{ href, label: attachmentLabel ?? '' }];
      const entries = links.flatMap(link => {
        const view = attachmentLinkView(link, options);
        return view ? [{ href: new URL(link.href, serverUrl).href, view }] : [];
      });
      const index = entries.findIndex(entry => entry.href === absoluteHref);
      if (index >= 0) openAttachment(entries[index].view, entries.map(entry => entry.view), index);
      else openAttachment(selected);
      return;
    }
    // Preserve standalone legacy opening when no read context was supplied.
    if (attachmentLink.kind === 'legacy' && !readContext && !attachmentLink.context.context && !attachmentLink.context.invalid) {
      if (!isLegacyAttachmentImage(attachmentLink.path)) await openExternal(attachmentLink.href);
      else if (openImage) openImage(cardImageSource(cardAttachmentUrl(serverUrl, attachmentLink.nodeId, attachmentLink.path), serverUrl, jwt));
      else alert('이미지를 열지 못했습니다.');
    } else alert('첨부를 열 수 없습니다.');
    return;
  }

  const target = serverUrl
    ? classifyInternalLink(href, [new URL(serverUrl).origin])
    : null;

  if (!target || target.kind === 'attachment_asset' || (target.kind === 'attachment' && !target.isImage)) {
    await openExternal(absoluteHref);
    return;
  }

  if (target.kind === 'attachment') {
    if (!openImage) {
      alertForMissingNavigation(alert, target);
      return;
    }
    const url = cardAttachmentUrl(serverUrl, target.nodeId, target.path);
    openImage(cardImageSource(url, serverUrl, jwt));
    return;
  }

  if (!navigation) {
    alertForMissingNavigation(alert, target);
    return;
  }

  if (target.kind === 'session') {
    const eventId = target.eventId === undefined ? undefined : Number(target.eventId);
    if (device === 'phone') {
      await openPhoneSearchSession(navigation as Parameters<typeof openPhoneSearchSession>[0], target.sessionId, eventId);
    } else if (isTabletMain(navigation)) {
      void openPlannerSessionWorkspace(target.sessionId, eventId, undefined, 'nav');
    } else {
      void openTabletSessionFromRoot(
        navigation as Parameters<typeof openTabletSessionFromRoot>[0],
        leavePersistent ?? null,
        target.sessionId,
        eventId,
        undefined,
        'nav',
      );
    }
    return;
  }

  if (target.kind === 'card') {
    if (device !== 'phone' && isTabletMain(navigation)) {
      useUIStore.getState().openCardOverlay(target.cardId, activeSessionId);
    } else if (navigation.push) {
      if (!isSameTopRouteTarget(navigation, 'CardDetail', 'cardId', target.cardId)) {
        navigation.push('CardDetail', { cardId: target.cardId });
      }
    } else {
      alertForMissingNavigation(alert, target);
    }
    return;
  }

  if (target.kind === 'document') {
    if (!navigation.push) {
      alertForMissingNavigation(alert, target);
      return;
    }
    if (isSameTopRouteTarget(navigation, 'MarkdownDocument', 'documentId', target.documentId)) return;
    navigation.push('MarkdownDocument', { documentId: target.documentId });
    return;
  }

  if (!api) {
    alertForMissingNavigation(alert, target);
    return;
  }

  try {
    if (target.kind === 'folder') {
      const detail = await api.getPlannerFolder(target.folderId, { includeCompleted: false });
      if (device === 'phone') {
        if (!openPhoneFolder(navigation, detail.page.id, detail.page.title, detail.folder.id)) {
          alertForMissingNavigation(alert, target);
        }
      } else if (isTabletMain(navigation)) {
        openPlannerFolderWorkspace(plannerFolderDetailToSummary(detail), 'nav');
      } else if (returnTabletToMain(navigation, leavePersistent)) {
        openPlannerFolderWorkspace(plannerFolderDetailToSummary(detail), 'nav');
      } else {
        alertForMissingNavigation(alert, target);
      }
      return;
    }

    if (target.kind === 'page') {
      const page = await api.getPage(target.pageId);
      if (device === 'phone') {
        if (!openPhoneFolder(navigation, page.page.id, page.page.title)) {
          alertForMissingNavigation(alert, target);
        }
      } else if (isTabletMain(navigation)) {
        openStarredPageWorkspace(target.pageId, 'nav');
      } else if (returnTabletToMain(navigation, leavePersistent)) {
        openStarredPageWorkspace(target.pageId, 'nav');
      } else {
        alertForMissingNavigation(alert, target);
      }
      return;
    }

  } catch (error) {
    alertUnlessUnauthorized(alert, target, error);
  }
}
