import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selectInstallLanguage } from '../seed/locales/installer-language.mjs';
import { installationLanguage } from '../windows/cli.mjs';
import { parseArgs } from '../windows/lib.mjs';

test('the Windows full installer passes language and console options to setup prepare', () => {
  const source = readFileSync(new URL('../install-windows.ps1', import.meta.url), 'utf8');
  assert.match(source, /\[string\]\$Lang\s*=/);
  assert.match(source, /\$prepare \+= @\("--lang", \$Lang\)/);
  assert.match(source, /if \(\$Lang\) \{ \$prepare \+= @\("--lang", \$Lang\) \}\s*else \{[^}]*\(Get-UICulture\)\.Name[\s\S]*?\$prepare \+= @\("--ui-culture", \$uiCulture\)/);
  assert.match(source, /\$NonInteractive\) \{ \$prepare \+= @\("--non-interactive", "true"\)/);
  assert.match(source, /Invoke-Native "node" \$prepare -InheritConsole:\(-not \$NonInteractive\)/);

  const root = mkdtempSync(join(tmpdir(), 'windows-prepare-lang-'));
  try {
    const setup = new URL('../windows/setup.mjs', import.meta.url);
    const result = spawnSync(process.execPath, [
      fileURLToPath(setup), 'prepare', '--install-root', root, '--lang', 'xx', '--non-interactive', 'true',
    ], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^Unknown installation language "xx"/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Windows option parsing forwards the requested language and respects existing state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'windows-lang-'));
  const savedLocale = process.env.LC_ALL;
  process.env.LC_ALL = 'en_US.UTF-8';
  try {
    const ctx = { soulDir: root };
    const select = (...args) => installationLanguage(ctx, parseArgs(['prepare', ...args]).options);
    assert.equal(await select('--lang', 'ko', '--ui-culture', 'en-US'), 'ko');
    assert.equal(await select('--ui-culture', 'ko-KR', '--non-interactive', 'true'), 'ko');
    await assert.rejects(select('--lang', 'xx'), /Unknown installation language "xx"/);
    mkdirSync(join(root, 'config'));
    const state = join(root, 'config', '.atom-seed-state.json');
    writeFileSync(state, '{"lang":"en"}');
    await assert.rejects(select('--lang', 'ko'), /en.*ko/);
    assert.equal(await select('--ui-culture', 'ko-KR'), 'en');
    writeFileSync(state, '{}');
    assert.equal(await select(), 'ko');
  } finally {
    if (savedLocale === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = savedLocale;
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [englishComplete, expected] of [[true, 'en'], [false, 'ko']]) {
  test(`unfinished Japanese falls back to ${expected}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'install-language-incomplete-'));
    try {
      const locales = join(root, 'locales');
      cpSync(new URL('../seed/locales/', import.meta.url), locales, { recursive: true });
      const manifest = join(locales, 'languages.json');
      const registry = JSON.parse(readFileSync(manifest, 'utf8'));
      registry.ja.complete = false;
      registry.en.complete = englishComplete;
      writeFileSync(manifest, JSON.stringify(registry));
      const fixture = await import(pathToFileURL(join(locales, 'installer-language.mjs')));
      await assert.rejects(fixture.selectInstallLanguage(root, 'ja', { interactive: false }), /Language ja is not available yet/);
      assert.equal(await fixture.selectInstallLanguage(root, undefined, { env: { LANG: 'ja-JP' }, interactive: false }), expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('language choice uses the locale or saved state and prompts only for interactive new installs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'install-language-'));
  try {
    assert.equal(await selectInstallLanguage(root, undefined, { env: { LANG: 'ja-JP' }, interactive: false }), 'ja');
    const locales = join(root, 'locales');
    cpSync(new URL('../seed/locales/', import.meta.url), locales, { recursive: true });
    const manifest = join(locales, 'languages.json');
    const registry = JSON.parse(readFileSync(manifest, 'utf8'));
    for (const language of Object.values(registry)) language.complete = true;
    writeFileSync(manifest, JSON.stringify(registry));
    const { selectInstallLanguage: selectFromFixture } = await import(pathToFileURL(join(locales, 'installer-language.mjs')));
    const select = (env) => selectFromFixture(root, undefined, { env, interactive: false });
    for (const [expected, locales] of [
      ['en', ['', 'C', 'C.UTF-8', 'POSIX', 'fr-FR', 'zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-HK', 'zh_TW.UTF-8', 'ZH_HANT_MO']],
      ['ko', ['ko', 'ko-KR', 'ko_KR.UTF-8']],
      ['ja', ['ja', 'ja-JP', 'ja_JP.UTF-8']],
      ['zh-Hans', ['zh', 'zh-CN', 'zh-SG', 'zh-Hans', 'zh_Hans_CN.UTF-8']],
    ]) {
      for (const locale of locales) assert.equal(await select({ LANG: locale }), expected, locale);
    }
    assert.equal(await select({ LC_ALL: 'ja_JP.UTF-8', LC_MESSAGES: 'zh-CN', LANG: 'ko_KR.UTF-8' }), 'ja');
    assert.equal(await select({ LC_ALL: '', LC_MESSAGES: 'zh-CN', LANG: 'ko_KR.UTF-8' }), 'zh-Hans');
    assert.equal(await selectFromFixture(root, undefined, { uiCulture: 'ko-KR', env: { LC_ALL: 'ja-JP', LANG: 'en-US' }, interactive: false }), 'ko');

    const input = new PassThrough();
    const output = new PassThrough();
    input.isTTY = output.isTTY = true;
    let transcript = '';
    output.on('data', (data) => { transcript += data; });
    const choice = selectFromFixture(root, undefined, { env: { LANG: 'ja_JP' }, input, output });
    input.end('en\n');
    assert.equal(await choice, 'en');
    assert.match(transcript, /Installation language \(ko, en, ja, zh-Hans\) \[ja\]: /);

    writeFileSync(join(root, '.atom-seed-state.json'), '{"lang":"zh-Hans"}');
    assert.equal(await select({ LANG: 'ja_JP' }), 'zh-Hans');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
