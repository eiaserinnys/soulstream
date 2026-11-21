const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');
const { resolveChatUiSourceRequest } = require('../../../scripts/chat-ui-source-resolution.cjs');
const sharedSourceFolders = require('../../../scripts/shared-source-folders.cjs');

const appRoot = path.resolve(__dirname, '../../..');
const reviewFixtures = path.join(appRoot, 'src/component-review');

const config = getDefaultConfig(__dirname);
config.watchFolders = [appRoot, ...sharedSourceFolders];
config.resolver.nodeModulesPaths = [path.join(appRoot, 'node_modules')];
const client = path.join(appRoot, 'src/api/client.ts');
const pickers = path.join(appRoot, 'src/hooks/attachmentPickers.ts');
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@react-native-async-storage/async-storage') return {
    type: 'sourceFile', filePath: path.join(reviewFixtures, 'fixture-async-storage.ts'),
  };
  if (moduleName === 'expo-secure-store') return {
    type: 'sourceFile', filePath: path.join(reviewFixtures, 'fixture-secure-store.ts'),
  };
  // react-native-webview has no web renderer; this check draws the same HTML in
  // a sandboxed iframe. Native keeps the real WKWebView.
  if (platform === 'web' && moduleName === 'react-native-webview') return {
    type: 'sourceFile', filePath: path.join(reviewFixtures, 'fixture-webview.web.tsx'),
  };
  const resolved = resolveChatUiSourceRequest(context,
    moduleName === 'event-target-shim/index' ? 'event-target-shim' : moduleName, platform);
  if (resolved.filePath === pickers) return {
    type: 'sourceFile', filePath: path.join(reviewFixtures, 'fixture-attachment-pickers.ts'),
  };
  return resolved.filePath === client
    ? { type: 'sourceFile', filePath: path.join(reviewFixtures, 'fixture-client.ts') }
    : resolved;
};
module.exports = config;
