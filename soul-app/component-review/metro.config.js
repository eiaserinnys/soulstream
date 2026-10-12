const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');
const { resolveChatUiSourceRequest } = require('../scripts/chat-ui-source-resolution.cjs');
const config = getDefaultConfig(__dirname);
config.watchFolders = [
  path.resolve(__dirname, '..'),
  path.resolve(__dirname, '../../packages/soul-ui/src/cards'),
  path.resolve(__dirname, '../../packages/soul-ui/src/lib'),
  path.resolve(__dirname, '../../packages/wire-schema/src'),
  path.resolve(__dirname, '../../packages/chat-ui'),
];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, '../node_modules')];
const client = path.resolve(__dirname, '../src/api/client.ts');
const pickers = path.resolve(__dirname, '../src/hooks/attachmentPickers.ts');
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Wrapper imports must resolve directly, before Expo's cached resolver can
  // return the replacement again and make the wrapper import itself.
  if (moduleName === '../components/events/EventContextMenu') return {
    type: 'sourceFile', filePath: path.resolve(__dirname, '../src/components/events/EventContextMenu.tsx'),
  };
  if (moduleName === '../components/chat-ui/ChatUiNodes') return {
    type: 'sourceFile', filePath: path.resolve(__dirname, '../src/components/chat-ui/ChatUiNodes.tsx'),
  };
  if (moduleName === '@react-native-async-storage/async-storage') return { type: 'sourceFile', filePath: path.resolve(__dirname, '../src/component-review/fixture-async-storage.ts') };
  if (moduleName === 'expo-secure-store') return { type: 'sourceFile', filePath: path.resolve(__dirname, '../src/component-review/fixture-secure-store.ts') };
  const resolved = resolveChatUiSourceRequest(context,
    moduleName === 'event-target-shim/index' ? 'event-target-shim' : moduleName, platform);
  if (platform === 'web') {
    for (const [source, fixture] of [
      ['components/events/EventContextMenu.tsx', 'fixture-chat-ui-menu.tsx'],
      ['components/chat-ui/ChatUiNodes.tsx', 'fixture-chat-ui-nodes.tsx'],
    ]) {
      const replacement = path.resolve(__dirname, '../src/component-review', fixture);
      if (context.originModulePath !== replacement && resolved.filePath === path.resolve(__dirname, '../src', source)) {
        return { type: 'sourceFile', filePath: replacement };
      }
    }
  }
  if (resolved.filePath === pickers) return { type: 'sourceFile', filePath: path.resolve(__dirname, '../src/component-review/fixture-attachment-pickers.ts') };
  return resolved.filePath === client
    ? { type: 'sourceFile', filePath: path.resolve(__dirname, '../src/component-review/fixture-client.ts') }
    : resolved;
};
module.exports = config;
