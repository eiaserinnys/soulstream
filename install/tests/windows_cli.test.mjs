import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installationLanguage } from '../windows/cli.mjs';
import { parseArgs } from '../windows/lib.mjs';

test('the Windows full installer passes language and console options to setup prepare', () => {
  const source = readFileSync(new URL('../install-windows.ps1', import.meta.url), 'utf8');
  assert.match(source, /\[string\]\$Lang\s*=/);
  assert.match(source, /\$prepare \+= @\("--lang", \$Lang\)/);
  assert.match(source, /\$NonInteractive\) \{ \$prepare \+= @\("--non-interactive", "true"\)/);
  assert.match(source, /Invoke-Native "node" \$prepare -InheritConsole:\(-not \$NonInteractive\)/);

  const root = mkdtempSync(join(tmpdir(), 'windows-prepare-lang-'));
  try {
    const setup = new URL('../windows/setup.mjs', import.meta.url);
    const result = spawnSync(process.execPath, [
      fileURLToPath(setup), 'prepare', '--install-root', root, '--lang', 'en', '--non-interactive', 'true',
    ], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^언어 en은\(는\) 아직 준비되지 않았습니다.*ko/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Windows option parsing forwards the requested language and respects existing state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'windows-lang-'));
  try {
    const ctx = { soulDir: root };
    const select = (...args) => installationLanguage(ctx, parseArgs(['prepare', ...args]).options);
    assert.equal(await select('--lang', 'ko'), 'ko');
    assert.equal(await select('--non-interactive', 'true'), 'ko');
    await assert.rejects(select('--lang', 'en'), /아직 준비되지 않았습니다/);
    mkdirSync(join(root, 'config'));
    const state = join(root, 'config', '.atom-seed-state.json');
    writeFileSync(state, '{"lang":"en"}');
    await assert.rejects(select('--lang', 'ko'), /en.*ko/);
    writeFileSync(state, '{}');
    assert.equal(await select(), 'ko');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('language choice uses the locale or saved state and prompts only for interactive new installs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'install-language-'));
  try {
    const locales = join(root, 'locales');
    cpSync(new URL('../seed/locales/', import.meta.url), locales, { recursive: true });
    const manifest = join(locales, 'languages.json');
    const registry = JSON.parse(readFileSync(manifest, 'utf8'));
    for (const language of Object.values(registry)) language.complete = true;
    writeFileSync(manifest, JSON.stringify(registry));
    const { selectInstallLanguage } = await import(pathToFileURL(join(locales, 'installer-language.mjs')));
    const select = (env) => selectInstallLanguage(root, undefined, { env, interactive: false });
    assert.equal(await select({ LANG: 'C.UTF-8' }), 'en');
    assert.equal(await select({ LANG: 'ko_KR.UTF-8' }), 'ko');
    assert.equal(await select({ LANG: 'ko_KR.UTF-8', LC_ALL: 'ja_JP.UTF-8' }), 'ja');
    assert.equal(await select({ LANG: 'zh-CN' }), 'zh-Hans');

    const input = new PassThrough();
    const output = new PassThrough();
    input.isTTY = output.isTTY = true;
    let transcript = '';
    output.on('data', (data) => { transcript += data; });
    const choice = selectInstallLanguage(root, undefined, { env: { LANG: 'ja_JP' }, input, output });
    input.end('en\n');
    assert.equal(await choice, 'en');
    assert.match(transcript, /Installation language \(ko, en, ja, zh-Hans\) \[ja\]: /);

    writeFileSync(join(root, '.atom-seed-state.json'), '{"lang":"zh-Hans"}');
    assert.equal(await select({ LANG: 'ja_JP' }), 'zh-Hans');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
