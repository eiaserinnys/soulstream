import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requireCompleteLanguage, requireKnownLanguage } from './languages.mjs';
import { fixedTitle, forbiddenSeedText, placeholderKeys } from './text.mjs';

export const defaultSeedPath = fileURLToPath(new URL('../atom-seed.json', import.meta.url));
const chunks = JSON.parse(readFileSync(new URL('chunks.json', import.meta.url), 'utf8'));
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function chunkInventory(seed) {
  const inventory = new Map(Object.keys(chunks).map((chunk) => [chunk, []]));
  for (const entry of seed.entries) {
    const matches = Object.entries(chunks).filter(([, prefixes]) =>
      prefixes.some((prefix) => entry.key === prefix || entry.key.startsWith(`${prefix}.`)));
    if (matches.length !== 1) {
      throw new Error(`Seed key ${entry.key} must belong to exactly one chunk (found: ${matches.map(([chunk]) => chunk).join(', ') || 'none'}).`);
    }
    inventory.get(matches[0][0]).push(entry);
  }
  return inventory;
}

export function validateOverlay(document, lang, chunk, inventory, seen) {
  if (document?.schema_version !== 1 || document.lang !== lang || document.chunk !== chunk || !isRecord(document.entries)) {
    throw new Error(`${lang}/${chunk}.json: expected schema_version 1, matching lang and chunk, and an entries object.`);
  }
  const cards = new Map(inventory.get(chunk).filter((entry) => entry.entry_kind === 'card').map((entry) => [entry.key, entry]));
  for (const [key, patch] of Object.entries(document.entries)) {
    const at = `${lang}/${chunk}.json: ${key}`;
    if (seen.has(key)) throw new Error(`${at}: duplicate translation.`);
    const original = cards.get(key);
    if (!original) throw new Error(`${at}: card key is not in chunk ${chunk}.`);
    if (!isRecord(patch) || Object.keys(patch).some((field) => !['title', 'content', 'tags'].includes(field))) {
      throw new Error(`${at}: expected an object with only title, content and optional tags.`);
    }
    if (typeof patch.title !== 'string' || !patch.title.trim() || [...patch.title].length > 50) {
      throw new Error(`${at}: title must contain 1 to 50 code points.`);
    }
    if (fixedTitle(original) && patch.title !== original.title) {
      throw new Error(`${at}: title must stay "${original.title}".`);
    }
    if (typeof patch.content !== 'string') throw new Error(`${at}: content must be a string.`);
    if (patch.tags !== undefined && (!Array.isArray(patch.tags) || patch.tags.some((tag) => typeof tag !== 'string'))) {
      throw new Error(`${at}: tags must be an array of strings.`);
    }
    for (const value of [patch.title, patch.content, ...(patch.tags ?? [])]) {
      const rule = forbiddenSeedText(value);
      if (rule) throw new Error(`${at}: forbidden seed text (${rule}).`);
    }
    const refs = (text) => JSON.stringify(placeholderKeys(text).sort());
    if (refs(patch.content) !== refs(original.content)) throw new Error(`${at}: node_id placeholders differ from the source.`);
    seen.set(key, patch);
  }
}

export function readOverlays(seed, lang, { localesDir = new URL('./', import.meta.url), complete = false, chunk } = {}) {
  requireKnownLanguage(lang);
  const inventory = chunkInventory(seed);
  if (chunk !== undefined && !inventory.has(chunk)) throw new Error(`Unknown chunk "${chunk}". Chunks: ${[...inventory.keys()].join(', ')}.`);
  const seen = new Map();
  if (lang === 'ko') return seen;
  const directory = new URL(`${lang}/`, localesDir);
  try {
    const expected = new Set(['installer.json', ...[...inventory.keys()].map((name) => `${name}.json`)]);
    for (const file of readdirSync(directory)) {
      if (file.endsWith('.json') && !expected.has(file)) throw new Error(`${lang}/${file}: unknown overlay filename.`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const name of chunk === undefined ? inventory.keys() : [chunk]) {
    let raw;
    try {
      raw = readFileSync(new URL(`${name}.json`, directory), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    let document;
    try {
      document = JSON.parse(raw);
    } catch (error) {
      throw new Error(`${lang}/${name}.json: ${error.message}`);
    }
    validateOverlay(document, lang, name, inventory, seen);
  }
  if (complete) {
    const missing = (chunk === undefined ? seed.entries : inventory.get(chunk))
      .filter((entry) => entry.entry_kind === 'card' && !seen.has(entry.key));
    if (missing.length > 0) throw new Error(`Missing translations for ${lang}: ${missing.map((entry) => entry.key).join(', ')}.`);
  }
  return seen;
}

export function mergeOverlays(seed, overlays) {
  return {
    ...seed,
    entries: seed.entries.map((entry) => overlays.has(entry.key) ? { ...entry, ...overlays.get(entry.key) } : entry),
  };
}

export function readLocalizedSeed(seedPath, lang) {
  requireCompleteLanguage(lang);
  const bytes = readFileSync(seedPath);
  const seed = JSON.parse(bytes.toString('utf8'));
  if (lang === 'ko') return { bytes, seed };
  const localized = mergeOverlays(seed, readOverlays(seed, lang, { complete: true }));
  return { bytes: Buffer.from(`${JSON.stringify(localized)}\n`), seed: localized };
}
