/** Route links to this server through the app while leaving other WebView navigation alone. */
export function webViewContentLinks(serverUrl: string, openContentLink: (url: string) => unknown) {
  const origin = serverUrl ? new URL(serverUrl).origin : null;
  return {
    originWhitelist: ['about:blank', 'https://pages.eiaserinnys.me', ...(origin ? [origin] : [])],
    onShouldStartLoadWithRequest: ({ url }: { url: string }) => {
      if (!origin || url === 'about:blank') return true;
      try {
        if (new URL(url).origin === origin) {
          void openContentLink(url);
          return false;
        }
      } catch { /* WebView keeps its normal handling for other URLs. */ }
      return true;
    },
  };
}
