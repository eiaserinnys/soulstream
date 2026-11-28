export const placeholderPattern = /\{\{node_id:([^}]+)\}\}/g;

export function placeholderKeys(content) {
  return [...String(content ?? '').matchAll(placeholderPattern)].map((match) => match[1]);
}

const forbidden = [
  ['UUID', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['email', /[A-Za-z0-9._%+-]+@(?!example\.(?:com|org)\b(?!\.[A-Za-z]))[A-Za-z0-9.-]+\.[A-Za-z]{2,}/i],
  ['non-loopback IPv4', /\b(?!127\.)(?:\d{1,3}\.){3}\d{1,3}\b/],
  ['private home path', /\/home\/(?!(?:soulstream|user|\.\.\.)(?:[/\s"'`)\]}]|$))[^/\s"'`)\]}]+/],
  ['private network address', /\.ts\.net\b/],
  ['card, PR or issue number', /(?:카드|PR|이슈|card|issue)\s*#\s*\d+/i],
  ['number sign followed by three or more digits', /#\d{3,}/],
  ['operating-standard tag', /운영\s*기준/i],
  ['dated case tag', /사례\s*\d{6}/i],
  ['private node, host or person name', /eiaserinnys|eias-linegames|linegames|silent-manari|netcup/i],
  ['internal agent name', /utonium|roselin|bubbles|buttercup|blossom|astra/i],
  ['internal agent name (carbon)', /(?<!-)(?<!gemini )carbon/i],
  ['internal deployment tool name', /haniel|하니엘/i],
  ['private tool or project name', /\barbor\b|\/EB\/|E&B|kal 지침/i],
  ['removed client name', new RegExp('kaleido' + 'scope', 'i')],
  ['director address or quotation', /디렉터님|디렉터의 말|디렉터(?!리)/i],
  ['card_id placeholder', /\{\{card_id:/],
];

export function forbiddenSeedText(text) {
  return forbidden.find(([, pattern]) => pattern.test(text))?.[0];
}

export function fixedTitle(entry) {
  return entry.parent === 'common.skills' || /\.md$/i.test(entry.title) || /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(entry.title);
}
