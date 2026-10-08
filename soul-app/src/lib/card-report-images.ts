import { parseStandaloneImageLine } from '../../../packages/soul-ui/src/lib/standalone-image-line';

export type CardReportSegment =
  | { kind: 'markdown'; markdown: string }
  | { kind: 'image'; alt: string; url: string };

// Card reports use standalone image lines. This is deliberately not a Markdown parser.
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export function segmentCardReportImages(markdown: string): CardReportSegment[] {
  const segments: CardReportSegment[] = [];
  let text: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  const flush = () => {
    if (text.length) segments.push({ kind: 'markdown', markdown: text.join('\n') });
    text = [];
  };
  for (const line of markdown.split(/\r?\n/)) {
    const candidate = FENCE_LINE.exec(line);
    if (fence) {
      text.push(line);
      if (candidate && candidate[1][0] === fence.marker && candidate[1].length >= fence.length && candidate[2].trim() === '') fence = null;
      continue;
    }
    if (candidate) {
      fence = { marker: candidate[1][0], length: candidate[1].length };
      text.push(line);
      continue;
    }
    const image = parseStandaloneImageLine(line);
    if (image) {
      flush();
      segments.push({ kind: 'image', alt: image.alt, url: image.url });
    } else text.push(line);
  }
  flush();
  return segments;
}
