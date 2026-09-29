const PROMPT_BOILERPLATE = "업무 현황을 파악한 후, 사용자의 다음 지시를 이행해주세요.";
const BM25_K1 = 1.5;
const BM25_B = 0.75;
const CODE_POINT_RADIX = 0x110000;
const PYTHON_WHITESPACE = /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
const PYTHON_WHITESPACE_RUN = /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;

export type SessionSummaryEvent = { readonly event_id: number; readonly content: string };

export type SessionDocumentRecord = {
  readonly session_id: string;
  readonly display_name: string | null;
  readonly prompt: string | null;
  readonly summary: string | null;
  readonly created_at: string;
  readonly agent_id: string | null;
};

export type SessionDocumentCard = {
  readonly title?: string;
  readonly request?: string;
  readonly summary?: string;
  readonly date?: string;
  readonly agent?: string;
};

export type SessionDocument = {
  readonly session_id: string;
  readonly title: string | null;
  readonly request: string | null;
  readonly summary: string | null;
  readonly text: string;
  readonly card: SessionDocumentCard;
};

export type SessionDocumentHit = SessionDocument & { readonly score: number };

export function bigramTermFrequencies(text: string): Map<string, number> {
  return new Map([...bigramCodePointFrequencies(text)].map(([term, frequency]) => [
    bigramCodePointTermToString(term),
    frequency,
  ]));
}

function bigramCodePointFrequencies(text: string): Map<number, number> {
  const frequencies = new Map<number, number>();
  let previousCodePoint: number | undefined;
  for (const character of text) {
    if (PYTHON_WHITESPACE.test(character)) continue;
    const codePoint = character.codePointAt(0)!;
    if (previousCodePoint === undefined) {
      previousCodePoint = codePoint;
      continue;
    }
    const term = previousCodePoint * CODE_POINT_RADIX + codePoint;
    frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    previousCodePoint = codePoint;
  }
  return frequencies;
}

function bigramCodePointTermToString(term: number): string {
  return String.fromCodePoint(Math.floor(term / CODE_POINT_RADIX), term % CODE_POINT_RADIX);
}

function compareBigramTerms(left: number, right: number): number {
  const leftText = bigramCodePointTermToString(left);
  const rightText = bigramCodePointTermToString(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

export function chooseSessionSummary(
  highlight: string | null,
  events: readonly SessionSummaryEvent[],
): string | null {
  if (highlight !== null) return highlight;
  const content = [...events]
    .sort((left, right) => left.event_id - right.event_id)
    .map((event) => event.content)
    .filter(Boolean);
  return content.length ? content.join(" / ") : null;
}

export function assembleSessionDocument(row: SessionDocumentRecord): SessionDocument {
  const title = cleanTitle(row.display_name);
  const request = cleanRequest(row.prompt);
  const summary = row.summary;
  const [requestText, requestCard] = clipPair(request, 1_500, 300);
  const [summaryText, summaryCard] = clipPair(summary, 1_500, 300);
  const text = [title ?? "", requestText, summaryText].join(" ");
  const card: SessionDocumentCard = compactCard({
    title: title ?? undefined,
    request: requestCard,
    summary: summaryCard,
    date: sessionDate(row.created_at),
    agent: row.agent_id ?? undefined,
  });
  return { session_id: row.session_id, title, request, summary, text, card };
}

export class SessionDocumentSearchIndex {
  private readonly documents = new Map<string, SessionDocument>();
  private postings = new Map<number, { readonly ids: Int32Array; readonly frequencies: Uint32Array }>();
  private lengths = new Float64Array();
  private averageLength = 0;
  private dirty = true;

  initialize(records: readonly SessionDocumentRecord[]): void {
    this.documents.clear();
    for (const record of records) this.documents.set(record.session_id, assembleSessionDocument(record));
    this.dirty = true;
    this.rebuild();
  }

  applyRefresh(
    records: readonly SessionDocumentRecord[],
    roster: readonly { readonly session_id: string; readonly display_name: string | null }[],
  ): void {
    const liveIds = new Set(roster.map((row) => row.session_id));
    for (const sessionId of this.documents.keys()) {
      if (!liveIds.has(sessionId)) {
        this.documents.delete(sessionId);
        this.dirty = true;
      }
    }
    for (const record of records) {
      if (!liveIds.has(record.session_id)) continue;
      this.documents.set(record.session_id, assembleSessionDocument(record));
      this.dirty = true;
    }
    const rosterNames = new Map(roster.map((row) => [row.session_id, row.display_name]));
    for (const [sessionId, document] of this.documents) {
      if (document.title !== cleanTitle(rosterNames.get(sessionId) ?? null)) {
        this.documents.delete(sessionId);
        this.dirty = true;
      }
    }
  }

  has(sessionId: string): boolean {
    return this.documents.has(sessionId);
  }

  get(sessionId: string): SessionDocument | undefined {
    return this.documents.get(sessionId);
  }

  get size(): number {
    return this.documents.size;
  }

  search(query: string, limit: number): SessionDocumentHit[] {
    this.rebuild();
    const queryTerms = [...bigramCodePointFrequencies(query).keys()].sort(compareBigramTerms);
    const scores = new Float64Array(this.documents.size);
    if (this.averageLength > 0) {
      for (const term of queryTerms) {
        const posting = this.postings.get(term);
        if (!posting) continue;
        const df = posting.ids.length;
        const idf = Math.log(1 + (this.documents.size - df + 0.5) / (df + 0.5));
        for (let index = 0; index < posting.ids.length; index += 1) {
          const ordinal = posting.ids[index]!;
          const frequency = posting.frequencies[index]!;
          const denominator = frequency + BM25_K1 * (
            1 - BM25_B + BM25_B * this.lengths[ordinal]! / this.averageLength
          );
          scores[ordinal] = scores[ordinal]! + idf * frequency * (BM25_K1 + 1) / denominator;
        }
      }
    }
    return [...this.documents.entries()]
      .map(([sessionId, document], ordinal) => ({ ...document, score: scores[ordinal] ?? 0, session_id: sessionId }))
      .sort((left, right) => right.score - left.score
        || (left.session_id < right.session_id ? -1 : left.session_id > right.session_id ? 1 : 0))
      .slice(0, limit);
  }

  private rebuild(): void {
    if (!this.dirty) return;
    const entries = [...this.documents.entries()];
    this.lengths = new Float64Array(entries.length);
    const mutable = new Map<number, { ids: number[]; frequencies: number[] }>();
    let totalLength = 0;
    for (const [ordinal, [, document]] of entries.entries()) {
      const terms = bigramCodePointFrequencies(document.text);
      let length = 0;
      for (const [term, frequency] of terms) {
        length += frequency;
        let posting = mutable.get(term);
        if (!posting) {
          posting = { ids: [], frequencies: [] };
          mutable.set(term, posting);
        }
        posting.ids.push(ordinal);
        posting.frequencies.push(frequency);
      }
      this.lengths[ordinal] = length;
      totalLength += length;
    }
    this.postings = new Map([...mutable.entries()].map(([term, posting]) => [term, {
      ids: Int32Array.from(posting.ids),
      frequencies: Uint32Array.from(posting.frequencies),
    }]));
    this.averageLength = entries.length ? totalLength / entries.length : 0;
    this.dirty = false;
  }
}

function cleanTitle(value: string | null): string | null {
  if (value === null) return null;
  const characters = Array.from(value);
  while (characters.length > 0 && (PYTHON_WHITESPACE.test(characters[0]!) || /^[\p{P}\p{S}]$/u.test(characters[0]!))) {
    characters.shift();
  }
  const cleaned = stripPythonWhitespace(characters.join(""));
  return cleaned || null;
}

function cleanRequest(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = stripPythonWhitespace(value.replaceAll(PROMPT_BOILERPLATE, "").replace(PYTHON_WHITESPACE_RUN, " "));
  return cleaned || null;
}

function stripPythonWhitespace(value: string): string {
  return value.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, "");
}

function clipPair(
  value: string | null,
  length: number,
  previewLength: number,
): readonly [string | undefined, string | undefined] {
  if (value === null) return [undefined, undefined];
  const characters: string[] = [];
  const preview: string[] = [];
  for (const character of value) {
    if (characters.length === length) break;
    characters.push(character);
    if (preview.length < previewLength) preview.push(character);
  }
  return [characters.join(""), preview.join("")];
}

function compactCard(value: Record<string, string | undefined>): SessionDocumentCard {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as SessionDocumentCard;
}

function sessionDate(value: string): string {
  const date = new Date(new Date(value).getTime() + 9 * 60 * 60 * 1_000);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}
