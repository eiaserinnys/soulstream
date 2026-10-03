const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.watchFolders = [
  path.resolve(__dirname, '..'),
  path.resolve(__dirname, '../../packages/soul-ui/src/cards'),
  path.resolve(__dirname, '../../packages/soul-ui/src/lib'),
];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, '../node_modules')];
const client = path.resolve(__dirname, '../src/api/client.ts');
const pickers = path.resolve(__dirname, '../src/hooks/attachmentPickers.ts');
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@react-native-async-storage/async-storage') return { type: 'sourceFile', filePath: path.resolve(__dirname, '../src/component-review/fixture-async-storage.ts') };
  if (moduleName === 'expo-secure-store') return { type: 'sourceFile', filePath: path.resolve(__dirname, '../src/component-review/fixture-secure-store.ts') };
  const resolved = context.resolveRequest(context,
    moduleName === 'event-target-shim/index' ? 'event-target-shim' : moduleName, platform);
  if (resolved.filePath === pickers) return { type: 'sourceFile', filePath: path.resolve(__dirname, '../src/component-review/fixture-attachment-pickers.ts') };
  return resolved.filePath === client
    ? { type: 'sourceFile', filePath: path.resolve(__dirname, '../src/component-review/fixture-client.ts') }
    : resolved;
};
module.exports = config;
