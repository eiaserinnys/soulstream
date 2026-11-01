jest.mock('expo/metro-config', () => ({
  getDefaultConfig: () => ({
    resolver: {
      assetExts: [],
      sourceExts: ['ts', 'tsx', 'mjs', 'js', 'jsx', 'json', 'cjs'],
      resolverMainFields: ['react-native', 'browser', 'main'],
      disableHierarchicalLookup: false,
      preferNativePlatform: true,
      unstable_enablePackageExports: true,
    },
    watchFolders: [],
  }),
}));

const config = require('./metro.config');
const reviewConfig = require('./component-review/metro.config');
const fs = require('node:fs');
const path = require('node:path');
const metroResolve = require('metro-resolver').resolve;
const { rewriteChatUiRelativeJsRequest } = require('./scripts/chat-ui-source-resolution.cjs');

const appRoot = __dirname;
const repoRoot = path.resolve(appRoot, '..');
const chatUiRoot = path.join(repoRoot, 'packages/chat-ui');
const chatUiSourceRoot = path.join(chatUiRoot, 'src');
const appImportFile = path.join(appRoot, 'src/lib/__tests__/chat-ui-package.contract.test.ts');

function fileSystemLookup(filePath) {
  try {
    const realPath = fs.realpathSync(filePath);
    const stats = fs.statSync(realPath);
    return { exists: true, type: stats.isDirectory() ? 'd' : 'f', realPath };
  } catch {
    return { exists: false };
  }
}

function readPackage(packageJsonPath) {
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return null;
  }
}

function packageForModule(modulePath) {
  let current = path.dirname(modulePath);
  while (current !== path.dirname(current)) {
    const packageJsonPath = path.join(current, 'package.json');
    const packageJson = readPackage(packageJsonPath);
    if (packageJson) {
      return {
        packageJson,
        rootPath: current,
        packageRelativePath: path.relative(current, modulePath),
      };
    }
    current = path.dirname(current);
  }
  return null;
}

function createResolverContext(metroConfig, originModulePath) {
  const resolverConfig = metroConfig.resolver;
  const context = {
    allowHaste: false,
    assetExts: new Set(resolverConfig.assetExts),
    customResolverOptions: resolverConfig.customResolverOptions ?? {},
    disableHierarchicalLookup: resolverConfig.disableHierarchicalLookup ?? false,
    doesFileExist: (filePath) => fileSystemLookup(filePath).exists,
    extraNodeModules: resolverConfig.extraNodeModules,
    dev: true,
    getPackage: readPackage,
    getPackageForModule: packageForModule,
    fileSystemLookup,
    mainFields: resolverConfig.resolverMainFields ?? ['react-native', 'browser', 'main'],
    originModulePath,
    nodeModulesPaths: resolverConfig.nodeModulesPaths ?? [],
    preferNativePlatform: resolverConfig.preferNativePlatform ?? true,
    resolveAsset: () => null,
    redirectModulePath: (modulePath) => modulePath,
    resolveHasteModule: () => null,
    resolveHastePackage: () => null,
    sourceExts: resolverConfig.sourceExts,
    unstable_conditionNames: resolverConfig.unstable_conditionNames ?? [],
    unstable_conditionsByPlatform: resolverConfig.unstable_conditionsByPlatform ?? {},
    unstable_enablePackageExports: resolverConfig.unstable_enablePackageExports ?? true,
    unstable_incrementalResolution: false,
    unstable_logWarning: () => {},
    resolveRequest: metroResolve,
  };
  return context;
}

function resolveMetroRequest(metroConfig, originModulePath, moduleName) {
  return metroConfig.resolver.resolveRequest(
    createResolverContext(metroConfig, originModulePath),
    moduleName,
    'ios',
  );
}

describe('Metro resolver compatibility', () => {
  it('uses the production client and storage unless native review is explicitly enabled', () => {
    const resolved = { type: 'sourceFile', filePath: path.join(appRoot, 'src/api/client.ts') };
    const context = { resolveRequest: jest.fn(() => resolved) };
    expect(config.resolver.resolveRequest(context, '../api/client', 'ios')).toBe(resolved);
    expect(config.resolver.resolveRequest(context, '@react-native-async-storage/async-storage', 'ios')).toBe(resolved);
  });

  it('uses isolated native fixtures only in native review mode', () => {
    let nativeConfig;
    jest.isolateModules(() => {
      process.env.SOUL_APP_NATIVE_REVIEW = '1';
      nativeConfig = require('./metro.config');
      delete process.env.SOUL_APP_NATIVE_REVIEW;
    });
    const context = { resolveRequest: jest.fn(() => ({ type: 'sourceFile', filePath: path.join(appRoot, 'src/api/client.ts') })) };
    expect(nativeConfig.resolver.resolveRequest(context, '../api/client', 'ios').filePath)
      .toBe(path.join(appRoot, 'native-review/fixture-client.ts'));
    expect(nativeConfig.resolver.resolveRequest(context, '@react-native-async-storage/async-storage', 'ios').filePath)
      .toBe(path.join(appRoot, 'src/component-review/fixture-async-storage.ts'));
  });
  it.each([
    ['../components/events/EventContextMenu', 'events/EventContextMenu.tsx', 'fixture-chat-ui-menu.tsx'],
    ['../components/chat-ui/ChatUiNodes', 'chat-ui/ChatUiNodes.tsx', 'fixture-chat-ui-nodes.tsx'],
  ])('review wrapper %s imports its real owner even if Expo has cached the replacement', (request, source, wrapper) => {
    const replacement = path.join(appRoot, 'src/component-review', wrapper);
    const resolveRequest = jest.fn(() => ({ type: 'sourceFile', filePath: replacement }));
    expect(reviewConfig.resolver.resolveRequest({ originModulePath: replacement, resolveRequest }, request, 'web'))
      .toEqual({ type: 'sourceFile', filePath: path.join(appRoot, 'src/components', source) });
    expect(resolveRequest).not.toHaveBeenCalled();
  });
  it('maps react-native-webrtc legacy event-target-shim subpath to the public root', () => {
    const resolved = { type: 'sourceFile', filePath: '/event-target-shim/index.js' };
    const resolveRequest = jest.fn(() => resolved);
    const context = { resolveRequest };

    expect(
      config.resolver.resolveRequest(context, 'event-target-shim/index', 'ios'),
    ).toBe(resolved);
    expect(resolveRequest).toHaveBeenCalledWith(
      context,
      'event-target-shim',
      'ios',
    );
  });

  it('leaves every other module specifier unchanged', () => {
    const resolved = { type: 'sourceFile', filePath: '/react/index.js' };
    const resolveRequest = jest.fn(() => resolved);
    const context = { resolveRequest };

    expect(config.resolver.resolveRequest(context, 'react', 'ios')).toBe(resolved);
    expect(resolveRequest).toHaveBeenCalledWith(context, 'react', 'ios');
  });

  it('rewrites only chat-ui relative .js requests with a TS source target', () => {
    const origin = path.join(chatUiSourceRoot, 'index.ts');
    expect(rewriteChatUiRelativeJsRequest(origin, './types.js')).toBe('./types');
    expect(rewriteChatUiRelativeJsRequest(chatUiSourceRoot, './types.js', true)).toBe('./types');
    expect(rewriteChatUiRelativeJsRequest(origin, './missing.js')).toBe('./missing.js');
    expect(rewriteChatUiRelativeJsRequest(appImportFile, './types.js')).toBe('./types.js');
    expect(rewriteChatUiRelativeJsRequest(origin, 'react-native')).toBe('react-native');
  });

  it('resolves the public entry and .js TypeScript imports in both Metro configs', () => {
    const nativeEntry = resolveMetroRequest(config, appImportFile, '@soulstream/chat-ui');
    const reviewEntry = resolveMetroRequest(reviewConfig, appImportFile, '@soulstream/chat-ui');

    expect(nativeEntry.type).toBe('sourceFile');
    expect(reviewEntry.type).toBe('sourceFile');
    expect(path.resolve(nativeEntry.filePath)).toBe(path.join(chatUiSourceRoot, 'index.ts'));
    expect(path.resolve(reviewEntry.filePath)).toBe(path.join(chatUiSourceRoot, 'index.ts'));

    const nativeTypes = resolveMetroRequest(config, nativeEntry.filePath, './types.js');
    const reviewTypes = resolveMetroRequest(reviewConfig, reviewEntry.filePath, './types.js');
    expect(path.resolve(nativeTypes.filePath)).toBe(path.join(chatUiSourceRoot, 'types.ts'));
    expect(path.resolve(reviewTypes.filePath)).toBe(path.join(chatUiSourceRoot, 'types.ts'));

    expect(config.watchFolders.map((folder) => path.resolve(folder))).toContain(chatUiRoot);
    expect(reviewConfig.watchFolders.map((folder) => path.resolve(folder))).toContain(chatUiRoot);
  });
});
