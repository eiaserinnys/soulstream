import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { assertStateLanguage, completeLanguages, readStateLanguage, requireCompleteLanguage } from './languages.mjs';

function localeLanguage(locale) {
  const [language, variant] = locale.toLowerCase().split(/[.@]/)[0].split(/[-_]/);
  if (language === 'ko' || language === 'ja') return language;
  if (language === 'zh' && !['tw', 'hk', 'mo', 'hant'].includes(variant)) return 'zh-Hans';
  return 'en';
}

export async function selectInstallLanguage(stateDir, requested, {
  uiCulture, env = process.env, input = process.stdin, output = process.stderr, interactive = true,
} = {}) {
  const saved = readStateLanguage(stateDir);
  if (saved !== null && requested !== undefined) assertStateLanguage(saved, requested);
  let lang = saved ?? requested;
  if (lang === undefined) {
    const preferred = localeLanguage(uiCulture ?? (env.LC_ALL || env.LC_MESSAGES || env.LANG || ''));
    const fallback = [preferred, 'en'].find((language) => completeLanguages.includes(language)) ?? 'ko';
    lang = fallback;
    if (interactive && input.isTTY && output.isTTY && completeLanguages.length > 1) {
      const terminal = createInterface({ input, output });
      try {
        output.write(`Installation language (${completeLanguages.join(', ')}) [${fallback}]: `);
        const { value } = await terminal[Symbol.asyncIterator]().next();
        lang = value?.trim() || fallback;
      } finally {
        terminal.close();
      }
    }
  }
  requireCompleteLanguage(lang);
  return lang;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${await selectInstallLanguage(process.argv[2], process.argv[3])}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
