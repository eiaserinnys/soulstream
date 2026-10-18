import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

/**
 * Component review only: react-native-webview has no web renderer, so RN web
 * shows the same HTML string in a sandboxed iframe. Native uses WKWebView.
 */
export function WebView({ source, style, testID }: {
  source?: { html?: string };
  style?: StyleProp<ViewStyle>;
  testID?: string;
  [key: string]: unknown;
}) {
  return <View testID={testID} style={style}>
    {React.createElement('iframe', {
      srcDoc: source?.html ?? '',
      title: testID ?? 'html',
      sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox',
      style: { border: 0, width: '100%', height: '100%', display: 'block' },
    })}
  </View>;
}

export default WebView;
