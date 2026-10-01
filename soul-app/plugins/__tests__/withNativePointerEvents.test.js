const { applyNativePointerEvents } = require('../withNativePointerEvents');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Expo 57's bundled bare template, preserving another config plugin's inserted startup code.
const source = `import Expo\nimport React\nimport ReactAppDependencyProvider\n\n@main\nclass AppDelegate: ExpoAppDelegate {\n  public override func application(\n    _ application: UIApplication,\n    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil\n  ) -> Bool {\n    // another plugin\n    let delegate = ReactNativeDelegate()\n    return super.application(application, didFinishLaunchingWithOptions: launchOptions)\n  }\n}\n`;

test('enables native pointer events before startup, preserves other transforms and is idempotent', () => {
  const patched = applyNativePointerEvents(source, 'swift');
  expect(patched).toContain('RCTSetDispatchW3CPointerEvents(true)');
  expect(patched.indexOf('RCTSetDispatchW3CPointerEvents(true)')).toBeLessThan(patched.indexOf('// another plugin'));
  expect(patched.replace('    // Soulstream: deliver iPad secondary pointer events before React surfaces exist.\n    RCTSetDispatchW3CPointerEvents(true)\n', '')).toBe(source);
  expect(applyNativePointerEvents(patched, 'swift')).toBe(patched);
  expect(patched.match(/RCTSetDispatchW3CPointerEvents/g)).toHaveLength(1);
});
test.each([
  ['import Expo\n', 'swift'], [source.replace('import React\n', ''), 'swift'],
  [source, 'objc'], [source.replace('didFinishLaunchingWithOptions', 'changedLaunch'), 'swift'],
])('unsupported template cannot silently omit pointer initialization', (contents, language) => {
  expect(() => applyNativePointerEvents(contents, language)).toThrow();
});

test('installed Expo template has the supported Swift import and startup ordering', () => {
  const archive = path.join(path.dirname(require.resolve('expo/package.json')), 'template.tgz');
  const template = execFileSync('tar', ['-xOf', archive, 'package/ios/HelloWorld/AppDelegate.swift'], { encoding: 'utf8' });
  const patched = applyNativePointerEvents(template, 'swift');
  expect(patched.indexOf('RCTSetDispatchW3CPointerEvents(true)')).toBeLessThan(patched.indexOf('let delegate = ReactNativeDelegate()'));
  expect(applyNativePointerEvents(patched, 'swift')).toBe(patched);
});
