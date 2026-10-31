export type MarkdownSegment =
  | { kind: 'markdown'; markdown: string }
  | { kind: 'blockquote'; markdown: string; plainText: string }
  | { kind: 'codeBlock'; markdown: string; copyText: string };

export type MarkdownBlockSegment = MarkdownSegment;

type Fence = {
  marker: '`' | '~';
  length: number;
};

const BLOCKQUOTE_LINE = /^ {0,3}>[ \t]?(.*)$/;
const FENCE_LINE = /^( *)(`{3,}|~{3,})(.*)$/;
const LIST_MARKER_LINE = /^( *)(?:[-+*]|\d+[.)])[ \t]+/;
const INTERRUPTING_BLOCK = /^ {0,3}(?:#{1,6}[ \t]|(?:[-+*]|\d+[.)])[ \t]+|`{3,}|~{3,})/;

export function segmentMarkdownBlockquotes(markdown: string): MarkdownBlockSegment[] {
  const lines = markdown.split(/\r?\n/);
  const segments: MarkdownBlockSegment[] = [];
  let normalLines: string[] = [];
  let quoteLines: string[] = [];
  let listIndent: number | null = null;
  let continuationIndent: number | null = null;
  let codeBlock: {
    fence: Fence;
    indent: number;
    maxFenceIndent: number;
    listIndent: number | null;
    lines: string[];
    codeLines: string[];
  } | null = null;

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

  for (let line of lines) {
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

    if (codeBlock) {
      const candidate = readFence(line, codeBlock.maxFenceIndent);
      if (isClosingFence(codeBlock.fence, candidate)) {
        codeBlock.lines.push(line.trimStart());
        segments.push({
          kind: 'codeBlock',
          markdown: codeBlock.lines.join('\n'),
          copyText: codeBlock.codeLines.join('\n'),
        });
        continuationIndent = codeBlock.listIndent;
        codeBlock = null;
      } else {
        const codeLine = stripOpeningIndent(line, codeBlock.indent);
        codeBlock.lines.push(codeLine);
        codeBlock.codeLines.push(codeLine);
      }
      continue;
    }

    if (BLOCKQUOTE_LINE.test(line)) {
      if (listIndent !== null && leadingSpaces(line) < listIndent) {
        listIndent = null;
        continuationIndent = null;
      }
      flushNormal();
      quoteLines.push(line);
      continue;
    }

    const listMarker = readListMarker(line, listIndent);
    if (listMarker !== null) {
      listIndent = listMarker;
      continuationIndent = null;
    }

    const maxFenceIndent = listIndent === null ? 3 : listIndent + 3;
    const fenceMatch = readFence(line, maxFenceIndent);
    if (fenceMatch) {
      flushNormal();
      codeBlock = {
        fence: { marker: fenceMatch.marker, length: fenceMatch.length },
        indent: fenceMatch.indent,
        maxFenceIndent,
        listIndent,
        lines: [stripOpeningIndent(line, fenceMatch.indent)],
        codeLines: [],
      };
      continue;
    }

    if (line.trim() !== '' && listMarker === null && listIndent !== null) {
      if (leadingSpaces(line) < listIndent) {
        listIndent = null;
        continuationIndent = null;
      } else if (continuationIndent !== null) {
        line = stripOpeningIndent(line, continuationIndent);
      }
    }

    normalLines.push(line);
  }

  if (codeBlock) {
    segments.push({
      kind: 'codeBlock',
      markdown: codeBlock.lines.join('\n'),
      copyText: codeBlock.codeLines.join('\n'),
    });
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

export const blockquotePlainText = extractBlockquotePlainText;

function stripOpeningIndent(line: string, indent: number): string {
  return indent > 0 && line.startsWith(' '.repeat(indent)) ? line.slice(indent) : line;
}

function readFence(
  line: string,
  maxIndent = 3,
): (Fence & { suffix: string; indent: number }) | null {
  const match = FENCE_LINE.exec(line);
  if (!match || match[1].length > maxIndent) return null;
  if (match[2][0] === '`' && match[3].includes('`')) return null;
  return {
    marker: match[2][0] as Fence['marker'],
    length: match[2].length,
    suffix: match[3],
    indent: match[1].length,
  };
}

function readListMarker(line: string, activeListIndent: number | null): number | null {
  const match = LIST_MARKER_LINE.exec(line);
  if (!match) return null;
  const markerIndent = match[1].length;
  if (markerIndent > 3 && (activeListIndent === null || markerIndent < activeListIndent)) return null;
  return match[0].length;
}

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
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
