/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'widget',
  name: 'UsageWidget',
  displayName: '주간 사용량',
  bundleIdentifier: '.usage-widget',
  deploymentTarget: '17.0',
  frameworks: ['AppIntents', 'SwiftUI', 'WidgetKit'],
  colors: {
    $accent: '#7C8BFF',
    $widgetBackground: { light: '#F3F0EA', dark: '#11131A' },
  },
  entitlements: {
    'com.apple.security.application-groups':
      config.ios.entitlements['com.apple.security.application-groups'],
  },
});
