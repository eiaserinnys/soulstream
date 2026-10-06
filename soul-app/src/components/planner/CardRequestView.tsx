import React, { useMemo } from 'react';
import { Text, View, type TextStyle } from 'react-native';
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
export function CardRequestView({ request, attachments: files = [], bodyStyle, numberOfLines, collapseBlankLines = false,
  attachmentImageVariant = 'default' }: {
  request: string; attachments?: readonly CardAttachment[]; bodyStyle?: TextStyle; numberOfLines?: number;
  collapseBlankLines?: boolean; attachmentImageVariant?: 'default' | 'cardCheckItem';
}) {
  const t = useTokens();
  const styles = useMemo(() => cardDetailStyles(t), [t]);
  const jwt = useAuthStore((state) => state.jwt);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const { text, attachments: legacy } = parseCardRequest(request, serverUrl);
  const displayText = collapseBlankLines ? text.replace(/(?:\r?\n[ \t]*){2,}/g, '\n') : text;
  const attachments = [...legacy, ...files.map((file) => ({ name: file.name,
    url: cardAttachmentUrl(serverUrl, file.nodeId, file.path), image: file.mimeType.startsWith('image/') }))];
  const source = (url: string) => cardImageSource(url, serverUrl, jwt);
  const images = attachments.filter((attachment) => attachment.image);
  const sources = images.map((image) => source(image.url));
  return <View style={styles.bodyStack}>
    {displayText ? <Text style={[styles.body, bodyStyle]} numberOfLines={numberOfLines} ellipsizeMode="tail" selectable>{displayText}</Text> : null}
    {attachments.map((attachment, index) => attachment.image
      ? <AttachmentImage key={`${attachment.url}-${index}`} testID={`card-request-image-${index}`} accessibilityLabel={attachment.name}
        source={source(attachment.url)} sources={sources} index={images.indexOf(attachment)} variant={attachmentImageVariant} />
      : <CompactTouchTarget key={`${attachment.url}-${index}`} accessibilityRole="link" accessibilityLabel={attachment.name}
        frameStyle={{ alignSelf: 'flex-start' }} onPress={() => { void WebBrowser.openBrowserAsync(source(attachment.url).uri!); }}>
        <Text style={[styles.body, bodyStyle, { color: t.colors.link }]}>{attachment.name}</Text>
      </CompactTouchTarget>)}
  </View>;
}
