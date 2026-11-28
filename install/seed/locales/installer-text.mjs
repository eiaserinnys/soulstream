import { readFileSync } from 'node:fs';
import { requireKnownLanguage } from './languages.mjs';

export function readInstallerText(lang, { required = true } = {}) {
  requireKnownLanguage(lang);
  const file = new URL(`${lang}/installer.json`, import.meta.url);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (!required && error.code === 'ENOENT') return null;
    throw error;
  }
  const text = JSON.parse(raw);
  const fields = [
    text?.profiles?.seosoyoung,
    text?.profiles?.['seosoyoung-pas'],
    text?.profiles?.['card-orchestrator'],
    text?.dailyReview?.name,
    text?.dailyReview?.prompt,
    text?.workspaceFolder,
    text?.codingAgentsPath,
  ];
  if (fields.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error(`${lang}/installer.json: expected non-empty profile names, dailyReview.name, dailyReview.prompt, workspaceFolder and codingAgentsPath.`);
  }
  return {
    profiles: text.profiles,
    dailyReview: { name: text.dailyReview.name, prompt: text.dailyReview.prompt },
    workspaceFolder: text.workspaceFolder,
    codingAgentsPath: text.codingAgentsPath,
  };
}
