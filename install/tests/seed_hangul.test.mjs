import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { completeLanguages } from '../seed/locales/languages.mjs';
import { defaultSeedPath, readLocalizedSeed } from '../seed/locales/seed.mjs';
import { forbiddenSeedText } from '../seed/locales/text.mjs';

const allowlist = JSON.parse(readFileSync(new URL('../seed/locales/hangul-allowlist.json', import.meta.url), 'utf8'));
const languages = completeLanguages.filter((lang) => lang !== 'ko');
const hangul = /\p{Script=Hangul}+/u;

test('Hangul allowlist contains unique public Hangul literals with a reason and source', () => {
  const seen = new Set();
  for (const { text, reason, source } of allowlist) {
    assert.match(text, hangul);
    assert.ok(!seen.has(text), `duplicate allowlist entry: ${text}`);
    seen.add(text);
    assert.ok(reason.trim(), `missing reason for ${text}`);
    assert.match(source, /^[^/\s][^\s]*:[1-9]\d*$/u, `invalid source for ${text}`);
    for (const value of [text, reason, source]) {
      assert.equal(forbiddenSeedText(value), undefined, `forbidden allowlist text: ${value}`);
    }
  }
});

test('complete translations contain only allowlisted Hangul and use each allowed literal', {
  skip: languages.length === 0 && 'Korean is the only complete seed language',
}, () => {
  const literals = allowlist.map(({ text }) => text).sort((a, b) => b.length - a.length);
  const used = new Set();
  const failures = [];
  for (const lang of languages) {
    const { seed } = readLocalizedSeed(defaultSeedPath, lang);
    for (const entry of seed.entries.filter(({ entry_kind }) => entry_kind === 'card')) {
      for (const field of ['title', 'content']) {
        let remaining = entry[field] ?? '';
        for (const literal of literals) {
          if (!remaining.includes(literal)) continue;
          used.add(literal);
          remaining = remaining.replaceAll(literal, (match) => ' '.repeat(match.length));
        }
        for (const match of remaining.matchAll(new RegExp(hangul, 'gu'))) {
          const start = match.index;
          const end = start + match[0].length;
          const original = entry[field];
          const before = [...original.slice(0, start)].slice(-20).join('');
          const after = [...original.slice(end)].slice(0, 20).join('');
          failures.push(`${lang} ${entry.key}.${field} [${match[0]}] ${JSON.stringify(before + match[0] + after)}`);
        }
      }
    }
  }
  failures.push(...literals.filter((literal) => !used.has(literal)).map((literal) => `Unused allowlist entry: ${literal}`));
  assert.equal(failures.length, 0, failures.join('\n'));
});
