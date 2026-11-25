// The installer and uninstaller tests must not touch this host. Their paths are all temporary, so the two
// fixed locations the real scripts use must look the same after the tests as before.
import assert from 'node:assert/strict';
import { lstatSync } from 'node:fs';

const HOST_PATHS = ['/etc/soulstream', '/var/log/soulstream-install.log'];
const present = (path) => { try { lstatSync(path); return true; } catch { return false; } };

export const snapshotHost = () => Object.fromEntries(HOST_PATHS.map((path) => [path, present(path)]));

export function assertHostUntouched(before) {
  for (const path of HOST_PATHS) {
    if (before[path]) {
      console.log(`${path} existed before these tests started; not checking it`);
      continue;
    }
    assert.equal(present(path), false, `${path} was created on this host by a test`);
  }
}
