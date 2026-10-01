const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '..')];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, '../node_modules')];
const client = path.resolve(__dirname, '../src/api/client.ts');
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'expo-secure-store') return { type: 'sourceFile', filePath: path.resolve(__dirname, '../src/component-review/fixture-secure-store.ts') };
  const resolved = context.resolveRequest(context,
    moduleName === 'event-target-shim/index' ? 'event-target-shim' : moduleName, platform);
  return resolved.filePath === client
    ? { type: 'sourceFile', filePath: path.resolve(__dirname, '../src/component-review/fixture-client.ts') }
    : resolved;
};
module.exports = config;
