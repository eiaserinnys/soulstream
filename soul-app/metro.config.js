const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// react-native-webrtc@124.0.7 still imports event-target-shim/index even though
// event-target-shim@6 only exports its package root. Resolve that one legacy
// specifier to the public root; keep package-exports enforcement enabled for
// every other dependency.
config.resolver.resolveRequest = (context, moduleName, platform) =>
  context.resolveRequest(
    context,
    moduleName === "event-target-shim/index" ? "event-target-shim" : moduleName,
    platform,
  );

module.exports = config;
