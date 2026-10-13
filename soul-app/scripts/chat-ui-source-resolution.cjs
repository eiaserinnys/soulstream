const fs = require('node:fs');
const path = require('node:path');

const sourceRoots = new Set([
  path.resolve(__dirname, '../../packages/chat-ui/src'),
  path.resolve(__dirname, '../node_modules/@soulstream/chat-ui/src'),
]);

function isWithin(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function rewriteChatUiRelativeJsRequest(originPathname, moduleName, originIsDirectory = false) {
  if (!moduleName.startsWith('.') || !moduleName.endsWith('.js')) return moduleName;

  const originPath = path.resolve(originPathname);
  const sourceRoot = [...sourceRoots].find((root) => isWithin(root, originPath));
  if (!sourceRoot) return moduleName;

  const extensionlessPath = path.resolve(
    originIsDirectory ? originPath : path.dirname(originPath),
    moduleName.slice(0, -3),
  );
  if (!isWithin(sourceRoot, extensionlessPath)) return moduleName;
  if (!fs.existsSync(`${extensionlessPath}.ts`) && !fs.existsSync(`${extensionlessPath}.tsx`)) {
    return moduleName;
  }
  return moduleName.slice(0, -3);
}

function resolveChatUiSourceRequest(context, moduleName, platform) {
  const rewritten = rewriteChatUiRelativeJsRequest(context.originModulePath, moduleName);
  return context.resolveRequest(context, rewritten, platform);
}

module.exports = {
  resolveChatUiSourceRequest,
  rewriteChatUiRelativeJsRequest,
};
