import React, { useMemo, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { WebView } from 'react-native-webview';
import type { CardReport } from '../../api/cardTypes';
import { buildCustomViewBindings, renderCustomViewHtml } from '../../lib/custom-view-renderer';
import { useTokens } from '../../theme';
import { PlannerMarkdownText } from './PlannerMarkdownText';

export function CardReportView({ report }: { report: CardReport }) {
  const t = useTokens();
  const { width } = useWindowDimensions();
  const [height, setHeight] = useState(t.foundation.minHeight.memo);
  const html = useMemo(() => renderCustomViewHtml(report.body, buildCustomViewBindings(null, {})), [report.body]);
  if (report.format === 'markdown') return <PlannerMarkdownText markdown={report.body} variant="card" />;
  return <WebView key={`${report.id}:${width}`} testID={`card-report-html-${report.id}`} source={{ html }}
    originWhitelist={['about:blank', 'https://pages.eiaserinnys.me']} javaScriptEnabled allowFileAccess={false}
    scrollEnabled={false} style={{ height, backgroundColor: t.colors.surfaceCode }}
    injectedJavaScript={'(function(){function size(){window.ReactNativeWebView.postMessage(String(Math.max(document.body.scrollHeight,document.documentElement.scrollHeight)));}new ResizeObserver(size).observe(document.body);size();})();true;'}
    onMessage={(event) => { const next = Number(event.nativeEvent.data); if (Number.isFinite(next) && next > 0) setHeight(Math.max(t.foundation.minHeight.memo, next)); }} />;
}
