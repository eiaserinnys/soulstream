// Static contract of the default install channel: the public commands, the seed text and the installer
// default must all name the verified `beta` branch. Nothing here runs the installer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path) => readFileSync(resolve(path), 'utf8');
const RAW = /https:\/\/raw\.githubusercontent\.com\/[^\s"'\\]+\/install\/(?:install|uninstall)\.sh/g;

for (const path of ['README.md', 'docs/guide/installation.md']) {
  test(`${path} downloads install.sh and uninstall.sh from the beta branch`, () => {
    const text = read(path);
    const urls = text.match(RAW) ?? [];
    assert.ok(urls.length > 0, `${path} has no installer URL`);
    for (const url of urls) assert.match(url, /\/soulstream\/beta\/install\/(?:install|uninstall)\.sh$/, url);
    assert.equal(text.split('/main/install/install.sh').length - 1, 0);
    assert.equal(text.split('/main/install/uninstall.sh').length - 1, 0);
  });
}

test('the atom seed has no installer URL on main', () => {
  const text = read('install/seed/atom-seed.json');
  assert.equal(text.split('/main/install/install.sh').length - 1, 0);
  assert.equal(text.split('/main/install/uninstall.sh').length - 1, 0);
});

test('the installer follows beta in both repositories by default', () => {
  const text = read('install/install.sh');
  assert.match(text, /^DEFAULT_SOULSTREAM_REF=beta$/m);
  assert.match(text, /^DEFAULT_ATOM_REF=beta$/m);
});
