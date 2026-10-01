export type MarkdownBlockSegment =
  | { kind: 'markdown'; markdown: string }
  | { kind: 'blockquote'; markdown: string; plainText: string };

type Fence = {
  marker: '`' | '~';
  length: number;
};

const BLOCKQUOTE_LINE = /^ {0,3}>[ \t]?(.*)$/;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const INTERRUPTING_BLOCK = /^ {0,3}(?:#{1,6}[ \t]|(?:[-+*]|\d+[.)])[ \t]+|`{3,}|~{3,})/;

export function segmentMarkdownBlockquotes(markdown: string): MarkdownBlockSegment[] {
  const lines = markdown.split(/\r?\n/);
  const segments: MarkdownBlockSegment[] = [];
  let normalLines: string[] = [];
  let quoteLines: string[] = [];
  let normalFence: Fence | null = null;

  const flushNormal = () => {
    if (normalLines.length === 0) return;
    segments.push({ kind: 'markdown', markdown: normalLines.join('\n') });
    normalLines = [];
  };

  const flushQuote = () => {
    if (quoteLines.length === 0) return;
    const quoteMarkdown = quoteLines.join('\n');
    segments.push({
      kind: 'blockquote',
      markdown: quoteMarkdown,
      plainText: extractBlockquotePlainText(quoteMarkdown),
    });
    quoteLines = [];
  };

  for (const line of lines) {
    if (quoteLines.length > 0) {
      if (BLOCKQUOTE_LINE.test(line)) {
        quoteLines.push(line);
        continue;
      }

      if (line.trim() === '') {
        flushQuote();
        normalLines.push(line);
        continue;
      }

      // CommonMark lazy continuation: a paragraph line may continue without
      // another `>` marker. A new block construct, however, ends the quote.
      if (!INTERRUPTING_BLOCK.test(line)) {
        quoteLines.push(line);
        continue;
      }

      flushQuote();
    }

    if (normalFence) {
      normalLines.push(line);
      normalFence = advanceFence(normalFence, line);
      continue;
    }

    if (BLOCKQUOTE_LINE.test(line)) {
      flushNormal();
      quoteLines.push(line);
      continue;
    }

    normalLines.push(line);
    normalFence = advanceFence(null, line);
  }

  flushQuote();
  flushNormal();
  return segments;
}

export function extractBlockquotePlainText(markdown: string): string {
  const output: string[] = [];
  let fence: Fence | null = null;

  for (const sourceLine of markdown.split(/\r?\n/)) {
    const line = stripQuoteMarkers(sourceLine);
    const fenceMatch = readFence(line);

    if (fence) {
      if (isClosingFence(fence, fenceMatch)) {
        fence = null;
      } else {
        output.push(line.replace(/[ \t]+$/, ''));
      }
      continue;
    }

    if (fenceMatch) {
      fence = {
        marker: fenceMatch.marker,
        length: fenceMatch.length,
      };
      continue;
    }

    const plainLine = markdownLineToPlainText(line);
    if (plainLine !== null) output.push(plainLine);
  }

  return output.join('\n').trim();
}

function advanceFence(activeFence: Fence | null, line: string): Fence | null {
  const match = readFence(line);
  if (!match) return activeFence;
  if (activeFence) {
    return isClosingFence(activeFence, match) ? null : activeFence;
  }
  return { marker: match.marker, length: match.length };
}

function readFence(line: string): (Fence & { suffix: string }) | null {
  const match = FENCE_LINE.exec(line);
  if (!match) return null;
  return {
    marker: match[1][0] as Fence['marker'],
    length: match[1].length,
    suffix: match[2],
  };
}

function isClosingFence(
  activeFence: Fence,
  candidate: (Fence & { suffix: string }) | null,
): boolean {
  return Boolean(
    candidate
      && candidate.marker === activeFence.marker
      && candidate.length >= activeFence.length
      && candidate.suffix.trim() === '',
  );
}

function stripQuoteMarkers(line: string): string {
  let rest = line;
  while (true) {
    const match = BLOCKQUOTE_LINE.exec(rest);
    if (!match) return rest;
    rest = match[1];
  }
}

function markdownLineToPlainText(line: string): string | null {
  if (/^ {0,3}\[[^\]]+\]:[ \t]+\S+/.test(line)) return null;
  if (/^ {0,3}\|?(?:[ \t]*:?-{3,}:?[ \t]*\|)+[ \t]*$/.test(line)) return null;
  if (/^ {0,3}(?:\*{3,}|-{3,}|_{3,})[ \t]*$/.test(line)) return '';

  const inlineCode: string[] = [];
  let plain = line
    .replace(/^ {0,3}#{1,6}[ \t]+/, '')
    .replace(/^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/, '')
    .replace(/^\[[ xX]\][ \t]+/, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, '$1')
    .replace(/(`+)(.*?)\1/g, (_match, _ticks, code: string) => {
      const index = inlineCode.push(code) - 1;
      return `\uE000${index}\uE001`;
    })
    .replace(/<[^>]+>/g, '');

  for (let pass = 0; pass < 3; pass += 1) {
    const before = plain;
    plain = plain
      .replace(/~~(.*?)~~/g, '$1')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/([*_])([^*_]+?)\1/g, '$2');
    if (plain === before) break;
  }

  plain = plain
    .replace(/\\([\\`*_[\]{}()#+\-.!>])/g, '$1')
    .replace(/[ \t]{2,}$/, '')
    .replace(/^\|[ \t]?/, '')
    .replace(/[ \t]?\|$/, '')
    .replace(/[ \t]*\|[ \t]*/g, '\t')
    .replace(/\uE000(\d+)\uE001/g, (_match, index: string) => (
      inlineCode[Number.parseInt(index, 10)] ?? ''
    ));

  return decodeHtmlEntities(plain);
}

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:amp|lt|gt|quot|#39|#x27|#(\d+)|#x([0-9a-f]+));/gi,
    (entity, decimal: string | undefined, hex: string | undefined) => {
      if (decimal) return decodeNumericEntity(entity, decimal, 10);
      if (hex) return decodeNumericEntity(entity, hex, 16);
      switch (entity.toLowerCase()) {
        case '&amp;':
          return '&';
        case '&lt;':
          return '<';
        case '&gt;':
          return '>';
        case '&quot;':
          return '"';
        case '&#39;':
        case '&#x27;':
          return '\'';
        default:
          return entity;
      }
    },
  );
}

function decodeNumericEntity(entity: string, digits: string, radix: number): string {
  const codePoint = Number.parseInt(digits, radix);
  if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10FFFF) {
    return entity;
  }
  return String.fromCodePoint(codePoint);
}
