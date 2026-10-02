import React, { useMemo, useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { WebView } from 'react-native-webview';
import type { CardReport } from '../../api/cardTypes';
import { buildCustomViewBindings, renderCustomViewHtml } from '../../lib/custom-view-renderer';
import { useTokens } from '../../theme';
import { PlannerMarkdownText } from './PlannerMarkdownText';
import { segmentCardReportImages } from '../../lib/card-report-images';
import { cardImageSource } from '../../lib/card-image-source';
import { useAuthStore } from '../../store/authStore';
import { useSettingsStore } from '../../store/settingsStore';
import { AttachmentImage } from '../AttachmentImage';
import { cardDetailStyles } from './CardDetail.styles';

export function CardReportView({ report }: { report: CardReport }) {
  const t = useTokens();
  const { width } = useWindowDimensions();
  const [height, setHeight] = useState(t.foundation.minHeight.memo);
  const html = useMemo(() => renderCustomViewHtml(report.body, buildCustomViewBindings(null, {})), [report.body]);
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
  const segments = useMemo(() => segmentCardReportImages(report.body), [report.body]);
  const gallery = segments.flatMap((part) => part.kind === 'image' ? [cardImageSource(part.url, serverUrl, jwt)] : []);
  let imageIndex = 0;
  return <View testID={`card-report-markdown-${report.id}`} style={styles.reportBodyStack}>{segments.map((part, index) => {
    if (part.kind === 'markdown') return part.markdown.trim()
      ? <PlannerMarkdownText key={index} markdown={part.markdown} variant="card" textAlign="left" /> : null;
    const current = imageIndex++;
    return <AttachmentImage key={index} testID={`card-report-image-${report.id}-${current}`}
      source={gallery[current]} sources={gallery} index={current} accessibilityLabel={part.alt || `보고 캡처 ${current + 1}`} />;
  })}</View>;
}
