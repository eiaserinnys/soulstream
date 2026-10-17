import type { AttachmentLink } from './attachment-link-view';

/** Inventory follows rendered links, excluding fenced/inline/indented code and definitions. */
function proseLines(body: string): string[] {
  let fence: { marker: string; length: number } | null = null;
  return body.split(/\r?\n/).map(line => {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (match && match[1][0] === fence.marker && match[1].length >= fence.length && !match[2].trim()) fence = null;
      return '';
    }
    if (match) { fence = { marker: match[1][0], length: match[1].length }; return ''; }
    return /^(?: {4}|\t)/.test(line) ? '' : line.replace(/(`+)[\s\S]*?\1/g, '');
  });
}

export function extractCardBodyLinks(body: string): AttachmentLink[] {
  const lines = proseLines(body);
  const definitions = new Map<string, string>();
  const normalize = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase();
  const content = lines.map(line => {
    const definition = /^ {0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+["'(].*)?$/.exec(line);
    if (!definition) return line;
    definitions.set(normalize(definition[1]), definition[2]);
    return '';
  }).join('\n');
  const result: AttachmentLink[] = [];
  const pattern = /!?\[([^\]\n]*)\](?:\(\s*<?([^\s>]+?)>?(?:\s+["'][^\n]*?["'])?\s*\)|\[([^\]\n]*)\])?/g;
  for (const match of content.matchAll(pattern)) {
    const href = match[2] ?? definitions.get(normalize(match[3] || match[1]));
    if (href) result.push({ href, label: match[1] });
  }
  return result;
}

/** Standalone image segments still share the block's Markdown reference definitions. */
export function withCardBodyReferences(markdown: string, body: string): string {
  const definitions = proseLines(body).filter(line => /^ {0,3}\[[^\]]+\]:/.test(line));
  return definitions.length ? `${markdown}\n\n${definitions.join('\n')}` : markdown;
}
