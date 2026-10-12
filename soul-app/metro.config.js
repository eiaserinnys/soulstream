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
config.resolver.resolveRequest = (context, moduleName, platform) =>
  resolveChatUiSourceRequest(
    context,
    moduleName === "event-target-shim/index" ? "event-target-shim" : moduleName,
    platform,
  );

module.exports = config;
