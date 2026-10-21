import React, { useMemo, useState } from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { WebView } from 'react-native-webview';
import type { CardReport } from '../../api/cardTypes';
import { buildCustomViewBindings, renderDocumentHtml } from '../../lib/custom-view-renderer';
import { useTokens } from '../../theme';
import { PlannerMarkdownText } from './PlannerMarkdownText';
import { segmentCardReportImages } from '../../lib/card-report-images';
import { cardImageSource } from '../../lib/card-image-source';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { AttachmentImage } from '../AttachmentImage';
import { cardDetailStyles } from './CardDetail.styles';
import { extractCardBodyLinks, withCardBodyReferences } from '../../lib/card-body-attachments';
import { parseExactAttachmentLink, scopedAttachmentUrl } from '../../lib/attachment-link-view';
import { useOpenContentLink } from '../../hooks/useOpenContentLink';
import { AttachmentBlockProvider, AttachmentReadContextProvider } from '../../navigation/ContentLinkProvider';

export function CardReportView({ report }: { report: CardReport }) {
  return <AttachmentReadContextProvider context={{ type: 'card', id: report.cardId }}>
    <AttachmentBlockProvider links={extractCardBodyLinks(report.body)}><CardReportContent report={report} /></AttachmentBlockProvider>
  </AttachmentReadContextProvider>;
}

function CardReportContent({ report }: { report: CardReport }) {
  const t = useTokens();
  const { width } = useWindowDimensions();
  const [height, setHeight] = useState(t.foundation.minHeight.memo);
  const html = useMemo(() => renderDocumentHtml(report.body, buildCustomViewBindings(null, {})), [report.body]);
  if (report.format === 'markdown') return <CardMarkdownReport report={report} />;
  return <WebView key={`${report.id}:${width}`} testID={`card-report-html-${report.id}`} source={{ html }}
    originWhitelist={['about:blank', 'https://pages.eiaserinnys.me']} javaScriptEnabled allowFileAccess={false}
    scrollEnabled={false} style={{ height, backgroundColor: t.colors.surfaceCode }}
    injectedJavaScript={'(function(){function size(){window.ReactNativeWebView.postMessage(String(Math.max(document.body.scrollHeight,document.documentElement.scrollHeight)));}new ResizeObserver(size).observe(document.body);size();})();true;'}
    onMessage={(event) => { const next = Number(event.nativeEvent.data); if (Number.isFinite(next) && next > 0) setHeight(Math.max(t.foundation.minHeight.memo, next)); }} />;
}

function CardMarkdownReport({ report }: { report: CardReport }) {
  const t = useTokens();
  const styles = useMemo(() => cardDetailStyles(t), [t]);
  const jwt = useAuthStore((state) => state.jwt);
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const openContentLink = useOpenContentLink();
  const segments = useMemo(() => segmentCardReportImages(report.body), [report.body]);
  const gallery = segments.flatMap((part) => part.kind === 'image' ? [cardImageSource(scopedAttachmentUrl(part.url, serverUrl, { type: 'card', id: report.cardId }), serverUrl, jwt)] : []);
  let imageIndex = 0;
  // RN web의 onPress는 응답자 협상과 별개인 DOM click으로 실행된다.
  const webClickBoundary = Platform.OS === 'web'
    ? { onClick: (event: { stopPropagation(): void }) => event.stopPropagation() } : {};
  // Own body touches, while allowing the scroll view or pager to take over a drag.
  return <View testID={`card-report-markdown-${report.id}`} style={styles.reportBodyStack} {...webClickBoundary}
    onStartShouldSetResponder={() => true} onResponderTerminationRequest={() => true}>{segments.map((part, index) => {
    if (part.kind === 'markdown') return part.markdown.trim()
      ? <PlannerMarkdownText key={index} markdown={withCardBodyReferences(part.markdown, report.body)} variant="card" textAlign="left" /> : null;
    const current = imageIndex++;
    return <AttachmentImage key={index} testID={`card-report-image-${report.id}-${current}`}
      onOpen={parseExactAttachmentLink(part.url, serverUrl) ? restoreFocus => { void openContentLink(part.url, part.alt, restoreFocus); } : undefined}
      source={gallery[current]} sources={gallery} index={current} accessibilityLabel={part.alt || `보고 캡처 ${current + 1}`} />;
  })}</View>;
}
