import React, { useCallback, useContext, useMemo } from 'react';
import { Alert } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { NavigationContext } from '@react-navigation/native';
import { createApiClient } from '../api/client';
import { useAuthStore } from '../store/authStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUIStore } from '../store/uiStore';
import { useDeviceType } from '../theme/useDeviceType';
import { useOptionalPersistentSessionHost } from '../navigation/PersistentSessionContext';
import { useAttachmentBlockLinks, useAttachmentReadContext, useContentLinkImageHost } from '../navigation/ContentLinkProvider';
import type { AttachmentLink } from '../lib/attachment-link-view';
import type { AttachmentReadContext } from '../../../packages/wire-schema/src/attachments';
import {
  openContentLinkNavigation,
  type ContentLinkNavigation,
} from '../lib/content-link-navigation';

export function useOpenContentLink(readContext?: AttachmentReadContext, links?: readonly AttachmentLink[]) {
  const navigation = useContext(NavigationContext);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const jwt = useAuthStore((state) => state.jwt);
  const device = useDeviceType();
  const persistentHost = useOptionalPersistentSessionHost();
  const imageHost = useContentLinkImageHost();
  const blockLinks = useAttachmentBlockLinks();
  const attachmentLinks = links ?? blockLinks;
  const providerReadContext = useAttachmentReadContext();
  const attachmentReadContext = readContext ?? providerReadContext;
  const api = useMemo(() => serverUrl ? createApiClient(serverUrl) : null, [serverUrl]);

  return useCallback((href: string, attachmentLabel?: string, restoreFocus?: () => void) => openContentLinkNavigation({
    href,
    attachmentLabel,
    attachmentLinks,
    serverUrl,
    jwt,
    api,
    navigation: navigation as ContentLinkNavigation | null,
    device,
    activeSessionId: useUIStore.getState().activeSessionId,
    leavePersistent: persistentHost ? () => persistentHost.store.getState().leave() : undefined,
    openImage: imageHost?.openImage,
    openAttachment: imageHost ? (view, items, initialIndex) => imageHost.openAttachment(view, items, initialIndex, restoreFocus) : undefined,
    readContext: attachmentReadContext,
    openExternal: (url) => WebBrowser.openBrowserAsync(url),
    alert: (message) => Alert.alert(message),
  }), [api, attachmentLinks, attachmentReadContext, device, imageHost, jwt, navigation, persistentHost, serverUrl]);
}
