const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');
const { resolveChatUiSourceRequest } = require('./chat-ui-source-resolution.cjs');

function createReviewMetroConfig(projectRoot) {
  const config = getDefaultConfig(projectRoot);
  config.watchFolders = [
    path.resolve(projectRoot, '..'),
    path.resolve(projectRoot, '../../packages/soul-ui/src/cards'),
    path.resolve(projectRoot, '../../packages/soul-ui/src/lib'),
    path.resolve(projectRoot, '../../packages/wire-schema/src'),
    path.resolve(projectRoot, '../../packages/chat-ui'),
  ];
  config.resolver.nodeModulesPaths = [path.resolve(projectRoot, '../node_modules')];
  const client = path.resolve(projectRoot, '../src/api/client.ts');
  const pickers = path.resolve(projectRoot, '../src/hooks/attachmentPickers.ts');
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    // Wrapper imports must resolve directly, before Expo's cached resolver can
    // return the replacement again and make the wrapper import itself.
    if (moduleName === '../components/events/EventContextMenu') return {
      type: 'sourceFile', filePath: path.resolve(projectRoot, '../src/components/events/EventContextMenu.tsx'),
    };
    if (moduleName === '../components/chat-ui/ChatUiNodes') return {
      type: 'sourceFile', filePath: path.resolve(projectRoot, '../src/components/chat-ui/ChatUiNodes.tsx'),
    };
    if (moduleName === '@react-native-async-storage/async-storage') return { type: 'sourceFile', filePath: path.resolve(projectRoot, '../src/component-review/fixture-async-storage.ts') };
    if (moduleName === 'expo-secure-store') return { type: 'sourceFile', filePath: path.resolve(projectRoot, '../src/component-review/fixture-secure-store.ts') };
    const resolved = resolveChatUiSourceRequest(context,
      moduleName === 'event-target-shim/index' ? 'event-target-shim' : moduleName, platform);
    if (platform === 'web') {
      for (const [source, fixture] of [
        ['components/events/EventContextMenu.tsx', 'fixture-chat-ui-menu.tsx'],
        ['components/chat-ui/ChatUiNodes.tsx', 'fixture-chat-ui-nodes.tsx'],
      ]) {
        const replacement = path.resolve(projectRoot, '../src/component-review', fixture);
        if (context.originModulePath !== replacement && resolved.filePath === path.resolve(projectRoot, '../src', source)) {
          return { type: 'sourceFile', filePath: replacement };
        }
      }
    }
    if (resolved.filePath === pickers) return { type: 'sourceFile', filePath: path.resolve(projectRoot, '../src/component-review/fixture-attachment-pickers.ts') };
    return resolved.filePath === client
      ? { type: 'sourceFile', filePath: path.resolve(projectRoot, '../src/component-review/fixture-client.ts') }
      : resolved;
  };
  return config;
}

module.exports = { createReviewMetroConfig };
