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
import { attachmentContentUrl, isLegacyAttachmentImage, type AttachmentView } from './attachment-view';
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
  'getPlannerFolder' | 'getPage' | 'getAttachmentMetadata'>;

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
  openAttachment?: (view: AttachmentView) => void;
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
  openExternal,
  alert,
}: OpenContentLinkNavigationArgs): Promise<void> {
  const absoluteHref = serverUrl ? new URL(href, serverUrl).href : href;
  const attachmentLink = serverUrl ? parseExactAttachmentLink(href, serverUrl) : null;

  if (attachmentLink?.kind === 'invalid') {
    alert('첨부를 열 수 없습니다.');
    return;
  }
  if (attachmentLink?.kind === 'id') {
    const context = resolveAttachmentReadContext(attachmentLink.context, readContext);
    if (!context) {
      alert('첨부를 열 수 없습니다.');
      return;
    }
    if (!api || !openAttachment) {
      alert('첨부를 열 수 없습니다.');
      return;
    }
    try {
      const { descriptor } = await api.getAttachmentMetadata(attachmentLink.id, context);
      const previewUrl = attachmentContentUrl(attachmentLink.id, context);
      openAttachment({
        key: attachmentLink.id,
        name: descriptor.name,
        mimeType: descriptor.mime_type || null,
        byteSize: Number.isSafeInteger(descriptor.byte_size) && descriptor.byte_size >= 0 ? descriptor.byte_size : null,
        previewKind: descriptor.preview_kind,
        readContext: context,
        source: {
          kind: 'ready',
          attachmentId: attachmentLink.id,
          previewUrl,
          originalUrl: attachmentContentUrl(attachmentLink.id, context, { download: true }),
        },
      });
    } catch (error) {
      if ((error as { status?: number } | null)?.status !== 401) alert('첨부를 열지 못했습니다.');
    }
    return;
  }
  if (attachmentLink?.kind === 'legacy') {
    const context = resolveAttachmentReadContext(attachmentLink.context, readContext);
    if (!context) {
      if (isLegacyAttachmentImage(attachmentLink.path)) {
        if (openImage) {
          openImage(cardImageSource(cardAttachmentUrl(serverUrl, attachmentLink.nodeId, attachmentLink.path), serverUrl, jwt));
        } else alert('이미지를 열지 못했습니다.');
      } else {
        await openExternal(attachmentLink.href);
      }
      return;
    }
    if (!openAttachment) {
      alert('첨부를 열 수 없습니다.');
      return;
    }
    try {
      const view = await readLegacyAttachmentView({
        href: attachmentLink.href,
        nodeId: attachmentLink.nodeId,
        path: attachmentLink.path,
        context,
        jwt,
      });
      openAttachment(view);
    } catch (error) {
      if ((error as { status?: number } | null)?.status !== 401) alert('첨부를 열지 못했습니다.');
    }
    return;
  }

  const target = serverUrl
    ? classifyInternalLink(href, [new URL(serverUrl).origin])
    : null;

  if (!target || (target.kind === 'attachment' && !target.isImage)) {
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

type AttachmentLinkContext = { context: AttachmentReadContext | null; invalid: boolean };
type ExactAttachmentLink =
  | { kind: 'id'; id: string; context: AttachmentLinkContext }
  | { kind: 'legacy'; nodeId: string; path: string; href: string; context: AttachmentLinkContext }
  | { kind: 'invalid' };

function parseExactAttachmentLink(href: string, serverUrl: string): ExactAttachmentLink | null {
  let url: URL;
  try {
    url = new URL(href, serverUrl);
    if (url.origin !== new URL(serverUrl).origin) return null;
  } catch {
    return null;
  }

  const idMatch = /^\/api\/attachments\/([^/]+)\/content$/.exec(url.pathname);
  if (idMatch) {
    let id: string;
    try { id = decodeURIComponent(idMatch[1]); } catch { return { kind: 'invalid' }; }
    if (!id || id.includes('/')) return { kind: 'invalid' };
    return { kind: 'id', id, context: readContextFromUrl(url) };
  }

  if (url.pathname !== '/api/attachments/files') return null;
  const nodeId = url.searchParams.get('nodeId');
  const path = url.searchParams.get('path');
  if (url.searchParams.getAll('nodeId').length !== 1 || url.searchParams.getAll('path').length !== 1
    || !nodeId || !path) return { kind: 'invalid' };
  return { kind: 'legacy', nodeId, path, href: url.href, context: readContextFromUrl(url) };
}

function readContextFromUrl(url: URL): AttachmentLinkContext {
  const types = url.searchParams.getAll('context_type');
  const ids = url.searchParams.getAll('context_id');
  if (types.length === 0 && ids.length === 0) return { context: null, invalid: false };
  if (types.length !== 1 || ids.length > 1) return { context: null, invalid: true };
  const type = types[0];
  const id = ids[0];
  if (type === 'owner' && id === undefined) return { context: { type: 'owner' }, invalid: false };
  if (!id) return { context: null, invalid: true };
  if (type === 'session' || type === 'card' || type === 'page' || type === 'board_item') {
    return { context: { type, id }, invalid: false };
  }
  return { context: null, invalid: true };
}

function resolveAttachmentReadContext(
  fromUrl: AttachmentLinkContext,
  fromProvider?: AttachmentReadContext,
): AttachmentReadContext | null {
  if (fromUrl.invalid) return null;
  return fromUrl.context ?? fromProvider ?? null;
}

async function readLegacyAttachmentView({ href, nodeId, path, context, jwt }: {
  href: string;
  nodeId: string;
  path: string;
  context: AttachmentReadContext;
  jwt: string | null;
}): Promise<AttachmentView> {
  const url = new URL(href);
  if (context.type === 'owner') {
    url.searchParams.delete('context_type');
    url.searchParams.delete('context_id');
  } else {
    url.searchParams.set('context_type', context.type);
    url.searchParams.set('context_id', context.id);
  }
  const response = await fetch(url.href, {
    method: 'HEAD',
    ...(jwt ? { headers: { Authorization: `Bearer ${jwt}` } } : {}),
  });
  if (!response.ok) throw { status: response.status };

  const mimeType = response.headers.get('content-type')?.split(';', 1)[0].trim() || null;
  const byteSizeHeader = response.headers.get('content-length');
  const parsedSize = byteSizeHeader && /^\d+$/.test(byteSizeHeader) ? Number(byteSizeHeader) : null;
  const name = filenameFromContentDisposition(response.headers.get('content-disposition')) || filenameFromPath(path);
  const attachmentId = response.headers.get('x-attachment-id') || `${nodeId}:${path}`;
  const kind = response.headers.get('x-attachment-id') ? previewKindForLegacy(mimeType, name) : legacyPreviewKind(mimeType, name);
  const originalUrl = new URL(url.href);
  originalUrl.searchParams.set('download', 'true');
  return {
    key: attachmentId,
    name,
    mimeType,
    byteSize: parsedSize !== null && Number.isSafeInteger(parsedSize) ? parsedSize : null,
    previewKind: kind,
    readContext: context,
    source: {
      kind: 'ready',
      attachmentId,
      previewUrl: url.href,
      originalUrl: originalUrl.href,
    },
  };
}

function legacyPreviewKind(mimeType: string | null, name: string): AttachmentView['previewKind'] {
  return isLegacyAttachmentImage(name) ? 'image' : 'info';
}

function previewKindForLegacy(mimeType: string | null, name: string): AttachmentView['previewKind'] {
  if (isLegacyAttachmentImage(name)) return 'image';
  if (mimeType?.startsWith('text/') || /\.(?:txt|md|json)$/i.test(name)) return 'text';
  return 'info';
}

function filenameFromPath(path: string): string {
  const filename = path.split(/[\\/]/).filter(Boolean).pop() ?? '';
  try { return decodeURIComponent(filename); } catch { return filename; }
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value)?.[1]?.trim();
  if (encoded) {
    try { return decodeURIComponent(encoded.replace(/^"|"$/g, '')); } catch { return null; }
  }
  const plain = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(value);
  return (plain?.[1] ?? plain?.[2])?.trim() || null;
}
