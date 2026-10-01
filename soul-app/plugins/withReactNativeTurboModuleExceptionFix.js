const fs = require('node:fs/promises');
const path = require('node:path');

const { withDangerousMod } = require('@expo/config-plugins');

const RCT_TURBO_MODULE_PATH = path.join(
  'node_modules',
  'react-native',
  'ReactCommon',
  'react',
  'nativemodule',
  'core',
  'platform',
  'ios',
  'ReactCommon',
  'RCTTurboModule.mm',
);

const ORIGINAL_EXCEPTION_HANDLER = [
  '    @try {',
  '      [inv invokeWithTarget:strongModule];',
  '    } @catch (NSException *exception) {',
  '      throw convertNSExceptionToJSError(runtime, exception, std::string{moduleName}, methodNameStr);',
  '    } @finally {',
].join('\n');

const PATCHED_EXCEPTION_HANDLER = [
  '    @try {',
  '      [inv invokeWithTarget:strongModule];',
  '    } @catch (NSException *exception) {',
  '      // Void methods are always async, re-throw instead of converting to',
  '      // JSError, same as the async branch in performMethodInvocation.',
  '      @throw exception;',
  '    } @finally {',
].join('\n');

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

function applyReactNativeTurboModuleExceptionFix(source) {
  const originalCount = countOccurrences(source, ORIGINAL_EXCEPTION_HANDLER);
  const patchedCount = countOccurrences(source, PATCHED_EXCEPTION_HANDLER);

  if (originalCount === 1 && patchedCount === 0) {
    return source.replace(ORIGINAL_EXCEPTION_HANDLER, PATCHED_EXCEPTION_HANDLER);
  }
  if (originalCount === 0 && patchedCount === 1) {
    return source;
  }

  throw new Error(
    'React Native TurboModule exception handler를 찾지 못했습니다. 설치된 RN 버전과 upstream 패치를 다시 대조하세요.',
  );
}

function withReactNativeTurboModuleExceptionFix(config) {
  return withDangerousMod(config, [
    'ios',
    async (dangerousConfig) => {
      const sourcePath = path.join(dangerousConfig.modRequest.projectRoot, RCT_TURBO_MODULE_PATH);
      const source = await fs.readFile(sourcePath, 'utf8');
      const patched = applyReactNativeTurboModuleExceptionFix(source);

      if (patched !== source) {
        await fs.writeFile(sourcePath, patched, 'utf8');
      }
      return dangerousConfig;
    },
  ]);
}

module.exports = withReactNativeTurboModuleExceptionFix;
module.exports.ORIGINAL_EXCEPTION_HANDLER = ORIGINAL_EXCEPTION_HANDLER;
module.exports.PATCHED_EXCEPTION_HANDLER = PATCHED_EXCEPTION_HANDLER;
module.exports.applyReactNativeTurboModuleExceptionFix = applyReactNativeTurboModuleExceptionFix;
