#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { completeLanguages, requireKnownLanguage } from './languages.mjs';
import { readInstallerText } from './installer-text.mjs';
import { chunkInventory, defaultSeedPath, readOverlays } from './seed.mjs';
import { fixedTitle } from './text.mjs';

const usage = [
  'node install/seed/locales/tool.mjs worklist --lang <lang> --chunk <chunk>',
  'node install/seed/locales/tool.mjs check --lang <lang> [--chunk <chunk>]',
].join('\n');

function showWorklist(lang, chunk, entries, overlays) {
  console.log(`# ${lang} / ${chunk}`);
  for (const entry of entries) {
    if (entry.entry_kind !== 'card') continue;
    const status = lang === 'ko' || overlays.has(entry.key) ? 'done' : 'todo';
    const fixed = fixedTitle(entry);
    console.log(
      `\n## [${status}] ${entry.key}\nTitle${fixed ? ' (keep)' : ''}: ${entry.title}\n\n${entry.content ?? ''}`,
    );
  }
}

function showProgress(lang, inventory, overlays) {
  console.log(`# ${lang}\n| Chunk | Entries | Body characters | Cards translated |\n| :--- | ---: | ---: | ---: |`);
  for (const [chunk, entries] of inventory) {
    const cards = entries.filter((entry) => entry.entry_kind === 'card');
    const translated = lang === 'ko' ? cards.length : cards.filter((entry) => overlays.has(entry.key)).length;
    const characters = cards.reduce((sum, entry) => sum + [...(entry.content ?? '')].length, 0);
    const percent = cards.length === 0 ? 100 : Math.round(translated / cards.length * 100);
    console.log(`| ${chunk} | ${entries.length} | ${characters} | ${translated}/${cards.length} (${percent}%) |`);
  }
}

function main() {
  const { positionals, values: { lang, chunk, help } } = parseArgs({
    allowPositionals: true,
    options: { lang: { type: 'string' }, chunk: { type: 'string' }, help: { type: 'boolean' } },
  });
  if (help) return console.log(usage);
  const [command] = positionals;
  if (positionals.length !== 1 || !['worklist', 'check'].includes(command) || !lang || (command === 'worklist' && !chunk)) {
    throw new Error(usage);
  }
  requireKnownLanguage(lang);
  const seed = JSON.parse(readFileSync(defaultSeedPath, 'utf8'));
  const inventory = chunkInventory(seed);
  const complete = completeLanguages.includes(lang);
  const overlays = readOverlays(seed, lang, { complete, chunk });
  if (command === 'worklist') return showWorklist(lang, chunk, inventory.get(chunk), overlays);
  readInstallerText(lang, { required: complete });
  showProgress(lang, chunk === undefined ? inventory : [[chunk, inventory.get(chunk)]], overlays);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
