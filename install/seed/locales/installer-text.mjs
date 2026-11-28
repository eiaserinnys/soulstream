import { readFileSync } from 'node:fs';
import { requireCompleteLanguage } from './languages.mjs';

export function readInstallerText(lang) {
  requireCompleteLanguage(lang);
  const file = new URL(`${lang}/installer.json`, import.meta.url);
  const text = JSON.parse(readFileSync(file, 'utf8'));
  const fields = [
    text?.profiles?.seosoyoung,
    text?.profiles?.['seosoyoung-pas'],
    text?.profiles?.['card-orchestrator'],
    text?.dailyReview?.name,
    text?.dailyReview?.prompt,
  ];
  if (fields.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error(`${lang}/installer.json: expected three profile names, dailyReview.name and dailyReview.prompt.`);
  }
  return text;
}
