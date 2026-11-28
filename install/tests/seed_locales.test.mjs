import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
