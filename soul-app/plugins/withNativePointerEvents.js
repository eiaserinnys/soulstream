const { withAppDelegate } = require('@expo/config-plugins');

const initialization = '    // Soulstream: deliver iPad secondary pointer events before React surfaces exist.\n    RCTSetDispatchW3CPointerEvents(true)\n';

function applyNativePointerEvents(contents, language) {
  if (language !== 'swift' || !/^import React\s*$/m.test(contents)) {
    throw new Error('Native pointer events require Expo Swift AppDelegate with import React.');
  }
  const launch = /didFinishLaunchingWithOptions launchOptions: \[UIApplication\.LaunchOptionsKey: Any\]\? = nil\s*\) -> Bool \{\r?\n/;
  const match = launch.exec(contents);
  if (!match) throw new Error('Native pointer events: supported didFinishLaunching anchor was not found.');
  const offset = match.index + match[0].length;
  if (contents.slice(offset).startsWith(initialization)) return contents;
  if (contents.includes('RCTSetDispatchW3CPointerEvents(')) {
    throw new Error('Native pointer events: unexpected existing initialization; check startup order.');
  }
  return contents.slice(0, offset) + initialization + contents.slice(offset);
}

module.exports = function withNativePointerEvents(config) {
  return withAppDelegate(config, (mod) => {
    mod.modResults.contents = applyNativePointerEvents(mod.modResults.contents, mod.modResults.language);
    return mod;
  });
};
module.exports.applyNativePointerEvents = applyNativePointerEvents;
