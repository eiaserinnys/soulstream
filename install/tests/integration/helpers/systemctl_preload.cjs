// Loaded with NODE_OPTIONS=--require by the installer schema test. The release executor runs the
// absolute systemctl for its live unit check; this points that one executable at the test's fake
// and leaves every other command as it is.
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');

const fake = process.env.INSTALLER_TEST_SYSTEMCTL;
if (!fake) throw new Error('INSTALLER_TEST_SYSTEMCTL is not set');
const SYSTEMCTL = new Set(['/usr/bin/systemctl', '/bin/systemctl']);
const execFile = childProcess.execFile;
childProcess.execFile = function execFileThroughFake(file, ...rest) {
  return execFile.call(this, SYSTEMCTL.has(file) ? fake : file, ...rest);
};
// The executor imports execFile as an ES module binding.
syncBuiltinESMExports();
