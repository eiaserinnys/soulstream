import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAtomSeed } from '../seed/load_atom_seed.mjs';
import {
  chunkInventory, defaultSeedPath, readLocalizedSeed, readOverlays, validateOverlay,
} from '../seed/locales/seed.mjs';

const bytes = readFileSync(defaultSeedPath);
const seed = JSON.parse(bytes);
const inventory = chunkInventory(seed);
const fixtureDir = new URL('./fixtures/seed-locales/', import.meta.url);
const persona = JSON.parse(readFileSync(new URL('en/persona.json', fixtureDir)));

test('the five chunks assign each seed entry exactly once', () => {
  assert.deepEqual([...inventory.keys()], ['core', 'catalogs', 'persona', 'skills-a', 'skills-b']);
  const keys = [...inventory.values()].flat().map((entry) => entry.key).sort();
  assert.deepEqual(keys, seed.entries.map((entry) => entry.key).sort());
  assert.throws(() => chunkInventory({ entries: [...seed.entries, { key: 'unknown.root' }] }), /exactly one chunk/);
});

test('partial translations validate by key, chunk, title and placeholder multiset', () => {
  const overlays = readOverlays(seed, 'en', { localesDir: fixtureDir });
  assert.deepEqual(Object.fromEntries(overlays), persona.entries);
  assert.throws(() => readOverlays(seed, 'en', { localesDir: fixtureDir, complete: true }), /Missing translations/);
  const invalid = (key, patch) => () => validateOverlay({
    ...persona, entries: { [key]: patch },
  }, 'en', 'persona', inventory, new Map());
  assert.throws(invalid('missing', { title: 'A', content: '' }), /not in chunk/);
  assert.throws(invalid('agent.root', { title: 'Agent', content: '' }), /not in chunk/);
  assert.throws(invalid('seosoyoung.root', { title: '😀'.repeat(51), content: '' }), /50 code points/);
  assert.throws(invalid('seosoyoung.rules.general', { title: 'General', content: '' }), /title must stay/);
  assert.throws(invalid('seosoyoung.root', { title: 'Agent', content: '{{node_id:agent.root}}' }), /placeholders differ/);
  assert.throws(invalid('seosoyoung.root', { title: 'Agent', content: 'PR #123' }), /forbidden/);
  assert.throws(invalid('seosoyoung.root', { title: 'Agent' }), /content must be a string/);
  const card = inventory.get('persona').find((entry) => entry.content?.includes('{{node_id:'));
  const excess = card.content + card.content.match(/\{\{node_id:[^}]+\}\}/)[0];
  assert.throws(invalid(card.key, { title: card.title, content: excess }), /placeholders differ/);
  const seen = new Map();
  validateOverlay(persona, 'en', 'persona', inventory, seen);
  assert.throws(() => validateOverlay(persona, 'en', 'persona', inventory, seen), /duplicate translation/);
});

test('Korean uses identical seed bytes and an unfinished language stops before Atom', async () => {
  assert.deepEqual(readLocalizedSeed(defaultSeedPath, 'ko').bytes, bytes);
  const stateDir = mkdtempSync(join(tmpdir(), 'seed-lang-'));
  const options = { stateDir, atomUrl: 'http://127.0.0.1:9', password: 'test', fetchImpl: () => assert.fail('unexpected Atom request') };
  try {
    await assert.rejects(loadAtomSeed({ ...options, lang: 'en' }), /아직 준비되지 않았습니다.*ko/);
    writeFileSync(join(stateDir, '.atom-seed-state.json'), JSON.stringify({ phase: 'completed', lang: 'en' }));
    await assert.rejects(loadAtomSeed({ ...options, lang: 'ko' }), /en.*ko/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('the loader hashes and keeps the same bytes that it sends for seed creation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'localized-loader-'));
  try {
    const requests = [];
    const options = {
      atomUrl: 'http://127.0.0.1:9', password: 'test',
      fetchImpl: async (url, init) => {
        const path = new URL(url).pathname;
        requests.push({ path, body: init.body });
        if (path === '/api/auth/password-login') return Response.json({}, { headers: { 'set-cookie': 'atom_auth=fixture' } });
        if (path === '/tree') return Response.json([]);
        return Response.json({}, { status: 503 });
      },
    };
    const run = async (loader, lang) => {
      const stateDir = join(root, lang);
      await assert.rejects(loader({ ...options, lang, stateDir }), { status: 503, path: '/batch' });
      const state = JSON.parse(readFileSync(join(stateDir, '.atom-seed-state.json')));
      const pending = readFileSync(join(stateDir, '.atom-seed-inprogress.json'));
      assert.equal(state.lang, lang);
      assert.equal(state.seed_sha256, createHash('sha256').update(pending).digest('hex'));
      return pending;
    };
    assert.deepEqual(await run(loadAtomSeed, 'ko'), bytes);

    const fixtureSeed = join(root, 'seed');
    cpSync(new URL('../seed/', import.meta.url), fixtureSeed, { recursive: true });
    const locales = join(fixtureSeed, 'locales');
    mkdirSync(join(locales, 'en'), { recursive: true });
    const languages = JSON.parse(readFileSync(join(locales, 'languages.json')));
    languages.en.complete = true;
    writeFileSync(join(locales, 'languages.json'), JSON.stringify(languages));
    for (const [chunk, entries] of inventory) {
      const patches = entries.filter((entry) => entry.entry_kind === 'card').map((entry) => [
        entry.key, persona.entries[entry.key] ?? { title: entry.title, content: entry.content ?? '' },
      ]);
      writeFileSync(join(locales, 'en', `${chunk}.json`), JSON.stringify({
        schema_version: 1, lang: 'en', chunk, entries: Object.fromEntries(patches),
      }));
    }
    const { loadAtomSeed: loadEnglish } = await import(pathToFileURL(join(fixtureSeed, 'load_atom_seed.mjs')));
    const pending = JSON.parse(await run(loadEnglish, 'en'));
    const key = 'seosoyoung.root';
    const fixture = persona.entries[key];
    assert.deepEqual(pending.entries.find((entry) => entry.key === key), {
      ...seed.entries.find((entry) => entry.key === key), ...fixture,
    });
    const batch = JSON.parse(requests.at(-1).body).creates.find((entry) => entry.temp_id === key);
    assert.equal(batch.title, fixture.title);
    assert.equal(batch.content, fixture.content);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
