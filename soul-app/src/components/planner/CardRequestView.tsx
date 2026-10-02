import React, { useMemo } from 'react';
import { Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { cardAttachmentUrl, parseCardRequest } from '../../lib/card-attachments';
import { cardImageSource } from '../../lib/card-image-source';
import type { CardAttachment } from '../../api/cardTypes';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useTokens } from '../../theme';
import { AttachmentImage } from '../AttachmentImage';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { cardDetailStyles } from './CardDetail.styles';

/** Card messages use the same image surface as chat; file names remain links. */
export function CardRequestView({ request, attachments: files = [] }: { request: string; attachments?: readonly CardAttachment[] }) {
  const t = useTokens();
  const styles = useMemo(() => cardDetailStyles(t), [t]);
  const jwt = useAuthStore((state) => state.jwt);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const { text, attachments: legacy } = parseCardRequest(request, serverUrl);
  const attachments = [...legacy, ...files.map((file) => ({ name: file.name,
    url: cardAttachmentUrl(serverUrl, file.nodeId, file.path), image: file.mimeType.startsWith('image/') }))];
  const source = (url: string) => cardImageSource(url, serverUrl, jwt);
  const images = attachments.filter((attachment) => attachment.image);
  const sources = images.map((image) => source(image.url));
  return <View style={styles.bodyStack}>
    {text ? <Text style={styles.body} selectable>{text}</Text> : null}
    {attachments.map((attachment, index) => attachment.image
      ? <AttachmentImage key={`${attachment.url}-${index}`} testID={`card-request-image-${index}`} accessibilityLabel={attachment.name}
        source={source(attachment.url)} sources={sources} index={images.indexOf(attachment)} />
      : <CompactTouchTarget key={`${attachment.url}-${index}`} accessibilityRole="link" accessibilityLabel={attachment.name}
        frameStyle={{ alignSelf: 'flex-start' }} onPress={() => { void WebBrowser.openBrowserAsync(source(attachment.url).uri!); }}>
        <Text style={[styles.body, { color: t.colors.link }]}>{attachment.name}</Text>
      </CompactTouchTarget>)}
  </View>;
}
