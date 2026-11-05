const path = require('node:path');
const { getDefaultConfig } = require("expo/metro-config");
const { resolveChatUiSourceRequest } = require('./scripts/chat-ui-source-resolution.cjs');

const config = getDefaultConfig(__dirname);
config.watchFolders = [
  ...(config.watchFolders ?? []),
  path.resolve(__dirname, '../packages/soul-ui/src/cards'),
  path.resolve(__dirname, '../packages/soul-ui/src/lib'),
  path.resolve(__dirname, '../packages/wire-schema/src'),
  path.resolve(__dirname, '../packages/chat-ui'),
];

// react-native-webrtc@124.0.7 still imports event-target-shim/index even though
// event-target-shim@6 only exports its package root. Resolve that one legacy
// specifier to the public root; keep package-exports enforcement enabled for
// every other dependency.
const defaultResolveRequest = (context, moduleName, platform) =>
  resolveChatUiSourceRequest(
    context,
    moduleName === "event-target-shim/index" ? "event-target-shim" : moduleName,
    platform,
  );
config.resolver.resolveRequest = process.env.SOUL_APP_NATIVE_REVIEW === '1'
  ? (context, moduleName, platform) => {
    const fixtures = {
      '@react-native-async-storage/async-storage': 'src/component-review/fixture-async-storage.ts',
      'expo-secure-store': 'src/component-review/fixture-secure-store.ts',
    };
    if (fixtures[moduleName]) return { type: 'sourceFile', filePath: path.resolve(__dirname, fixtures[moduleName]) };
    const resolved = defaultResolveRequest(context, moduleName, platform);
    if (resolved.filePath === path.resolve(__dirname, 'src/api/client.ts')) {
      return { type: 'sourceFile', filePath: path.resolve(__dirname, 'native-review/fixture-client.ts') };
    }
    if (resolved.filePath === path.resolve(__dirname, 'src/hooks/attachmentPickers.ts')) {
      return { type: 'sourceFile', filePath: path.resolve(__dirname, 'src/component-review/fixture-attachment-pickers.ts') };
    }
    return resolved;
  }
  : defaultResolveRequest;

module.exports = config;
