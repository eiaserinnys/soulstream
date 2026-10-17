import React, { useMemo } from 'react';
import { Platform, Text, View, type TextStyle } from 'react-native';
import { cardAttachmentUrl, parseCardRequest } from '../../lib/card-attachments';
import { cardImageSource } from '../../lib/card-image-source';
import type { CardAttachment } from '../../api/cardTypes';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useTokens } from '../../theme';
import { AttachmentImage } from '../AttachmentImage';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { cardDetailStyles } from './CardDetail.styles';
import { useOpenContentLink } from '../../hooks/useOpenContentLink';
import { AttachmentBlockProvider, useAttachmentReadContext } from '../../navigation/ContentLinkProvider';
import { segmentCardReportImages } from '../../lib/card-report-images';
import { extractCardBodyLinks, withCardBodyReferences } from '../../lib/card-body-attachments';
import { parseExactAttachmentLink, scopedAttachmentUrl } from '../../lib/attachment-link-view';
import { PlannerMarkdownText } from './PlannerMarkdownText';
import type { AttachmentReadContext } from '../../../../packages/wire-schema/src/attachments';

/** Card messages use the same image surface as chat; file names remain links. */
export function CardRequestView({ request, attachments: files = [], bodyStyle, numberOfLines, collapseBlankLines = false,
  attachmentImageVariant = 'default', readContext }: {
  request: string; attachments?: readonly CardAttachment[]; bodyStyle?: TextStyle; numberOfLines?: number;
  collapseBlankLines?: boolean; attachmentImageVariant?: 'default' | 'cardCheckItem'; readContext?: AttachmentReadContext;
}) {
  const t = useTokens();
  const inheritedContext = useAttachmentReadContext();
  const context = readContext ?? inheritedContext;
  const styles = useMemo(() => cardDetailStyles(t), [t]);
  const jwt = useAuthStore((state) => state.jwt);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const { text, attachments: legacy } = parseCardRequest(request, serverUrl);
  const displayText = collapseBlankLines ? text.replace(/(?:\r?\n[ \t]*){2,}/g, '\n') : text;
  const attachments = [...legacy, ...files.map((file) => ({ name: file.name,
    url: cardAttachmentUrl(serverUrl, file.nodeId, file.path), image: file.mimeType.startsWith('image/') }))];
  const bodyLinks = extractCardBodyLinks(text);
  const renderMarkdown = numberOfLines === undefined && bodyLinks.some(link => !!parseExactAttachmentLink(link.href, serverUrl));
  const links = [...bodyLinks, ...attachments.map(({ url: href, name: label }) => ({ href, label }))];
  const openContentLink = useOpenContentLink(context, links);
  const internal = (url: string) => !!parseExactAttachmentLink(url, serverUrl);
  const source = (url: string) => cardImageSource(scopedAttachmentUrl(url, serverUrl, context), serverUrl, jwt);
  const images = attachments.filter((attachment) => attachment.image);
  const sources = images.map((image) => source(image.url));
  // Full body attachment taps must not also fold the surrounding timeline entry.
  const ownsBodyTouches = numberOfLines === undefined && links.some(link => internal(link.href));
  const webClickBoundary = ownsBodyTouches && Platform.OS === 'web' ? { onClick: (event: { stopPropagation(): void }) => event.stopPropagation() } : {};
  return <AttachmentBlockProvider links={links}><View style={styles.bodyStack} {...webClickBoundary} onStartShouldSetResponder={() => ownsBodyTouches} onResponderTerminationRequest={() => true}>
    {displayText && renderMarkdown ? segmentCardReportImages(displayText).map((part, index) => part.kind === 'markdown'
      ? part.markdown.trim() ? <PlannerMarkdownText key={index} markdown={withCardBodyReferences(part.markdown, displayText)} variant="card" textAlign="left" readContext={context} /> : null
      : <AttachmentImage key={index} testID={`card-request-body-image-${index}`} source={source(part.url)} accessibilityLabel={part.alt || '첨부 이미지'}
        onOpen={internal(part.url) ? restoreFocus => { void openContentLink(part.url, part.alt, restoreFocus); } : undefined} />) : displayText ? <Text style={[styles.body, bodyStyle]} numberOfLines={numberOfLines} ellipsizeMode="tail" selectable>{displayText}</Text> : null}
    {attachments.map((attachment, index) => attachment.image
      ? <AttachmentImage key={`${attachment.url}-${index}`} testID={`card-request-image-${index}`} accessibilityLabel={attachment.name}
        onOpen={internal(attachment.url) ? restoreFocus => { void openContentLink(attachment.url, attachment.name, restoreFocus); } : undefined}
        source={source(attachment.url)} sources={sources} index={images.indexOf(attachment)} variant={attachmentImageVariant} />
      : <CompactTouchTarget key={`${attachment.url}-${index}`} accessibilityRole="link" accessibilityLabel={attachment.name}
        frameStyle={{ alignSelf: 'flex-start' }} onPress={() => { void openContentLink(attachment.url, attachment.name); }}>
        <Text style={[styles.body, bodyStyle, { color: t.colors.link }]}>{attachment.name}</Text>
      </CompactTouchTarget>)}
  </View></AttachmentBlockProvider>;
}
