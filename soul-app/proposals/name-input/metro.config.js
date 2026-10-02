const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
const appRoot = path.resolve(__dirname, '../..');
config.watchFolders = [appRoot];
config.resolver.nodeModulesPaths = [path.join(appRoot, 'node_modules')];
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'expo-secure-store') return { type: 'sourceFile', filePath: path.join(appRoot, 'src/component-review/fixture-secure-store.ts') };
  return context.resolveRequest(context, moduleName === 'event-target-shim/index' ? 'event-target-shim' : moduleName, platform);
};
module.exports = config;
