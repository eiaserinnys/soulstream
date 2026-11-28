import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const languages = JSON.parse(readFileSync(new URL('languages.json', import.meta.url), 'utf8'));
export const knownLanguages = Object.keys(languages);
export const completeLanguages = knownLanguages.filter((lang) => languages[lang].complete);
export const stateFile = '.atom-seed-state.json';

export function requireKnownLanguage(lang) {
  if (!knownLanguages.includes(lang)) {
    throw new Error(`Unknown installation language "${lang}". Supported languages: ${knownLanguages.join(', ')}.`);
  }
}

export function requireCompleteLanguage(lang) {
  requireKnownLanguage(lang);
  if (!completeLanguages.includes(lang)) {
    throw new Error(`언어 ${lang}은(는) 아직 준비되지 않았습니다. 선택 가능한 언어 / Available languages: ${completeLanguages.join(', ')}.`);
  }
}

export function assertStateLanguage(saved, requested) {
  if (saved !== requested) {
    throw new Error(`Atom seed state uses language ${saved}. Cannot switch to ${requested} on an existing installation.`);
  }
}

export function readStateLanguage(stateDir) {
  const file = join(stateDir, stateFile);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const state = JSON.parse(raw);
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error(`Invalid atom seed state: ${file}`);
  const lang = state.lang === undefined ? 'ko' : state.lang;
  requireKnownLanguage(lang);
  return lang;
}
