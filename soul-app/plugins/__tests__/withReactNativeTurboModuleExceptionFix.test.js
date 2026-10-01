const {
  ORIGINAL_EXCEPTION_HANDLER,
  PATCHED_EXCEPTION_HANDLER,
  applyReactNativeTurboModuleExceptionFix,
} = require('../withReactNativeTurboModuleExceptionFix');

describe('withReactNativeTurboModuleExceptionFix', () => {
  it('ports the upstream RN fix into the vulnerable exception handler', () => {
    const synchronousConversion =
      '      throw convertNSExceptionToJSError(runtime, exception, std::string{moduleName}, methodNameStr);';
    const source = `sync branch\n${synchronousConversion}\nvoid branch\n${ORIGINAL_EXCEPTION_HANDLER}\nafter`;

    const patched = applyReactNativeTurboModuleExceptionFix(source);

    expect(patched).toBe(
      `sync branch\n${synchronousConversion}\nvoid branch\n${PATCHED_EXCEPTION_HANDLER}\nafter`,
    );
    expect(patched.match(/convertNSExceptionToJSError\(runtime, exception/g)).toHaveLength(1);
  });

  it('is idempotent when prebuild runs more than once', () => {
    const source = `before\n${PATCHED_EXCEPTION_HANDLER}\nafter`;

    expect(applyReactNativeTurboModuleExceptionFix(source)).toBe(source);
  });

  it('fails closed when the installed React Native source no longer matches', () => {
    expect(() => applyReactNativeTurboModuleExceptionFix('unexpected upstream source')).toThrow(
      'React Native TurboModule exception handler를 찾지 못했습니다',
    );
  });
});
