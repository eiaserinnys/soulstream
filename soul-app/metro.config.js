const { getDefaultConfig } = require("expo/metro-config");
const { resolveChatUiSourceRequest } = require('./scripts/chat-ui-source-resolution.cjs');
const sharedSourceFolders = require('./scripts/shared-source-folders.cjs');

const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), ...sharedSourceFolders];

config.resolver.resolveRequest = (context, moduleName, platform) =>
  resolveChatUiSourceRequest(
    context,
    moduleName === "event-target-shim/index" ? "event-target-shim" : moduleName,
    platform,
  );

module.exports = config;
