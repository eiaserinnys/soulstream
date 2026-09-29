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
  readonly title: string | null;
  readonly codePoints: Uint32Array;
  readonly bigramLength: number;
  readonly card: SessionDocumentCard;
};

export type SessionDocumentRosterRow = {
  readonly session_id: string;
  readonly display_name: string | null;
};

export type SessionDocumentHit = {
  readonly session_id: string;
  readonly document: SessionDocument;
  readonly score: number;
};

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
  const codePoints = documentCodePoints([title ?? "", requestText ?? "", summaryText ?? ""]);
  const card: SessionDocumentCard = compactCard({
    title: title ?? undefined,
    request: requestCard,
    summary: summaryCard,
    date: sessionDate(row.created_at),
    agent: row.agent_id ?? undefined,
  });
  return { title, codePoints, bigramLength: Math.max(0, codePoints.length - 1), card };
}

export class SessionDocumentSearchIndex {
  private readonly documents = new Map<string, SessionDocument>();
  private totalBigramLength = 0;

  initialize(records: readonly SessionDocumentRecord[]): void {
    this.documents.clear();
    this.totalBigramLength = 0;
    for (const record of records) this.replace(record);
  }

  applyRefresh(
    records: readonly SessionDocumentRecord[],
    deletedSessionIds: readonly string[],
  ): void {
    for (const sessionId of deletedSessionIds) this.remove(sessionId);
    for (const record of records) this.replace(record);
  }

  findRosterChanges(roster: readonly SessionDocumentRosterRow[]): {
    readonly refreshSessionIds: string[];
    readonly deletedSessionIds: string[];
  } {
    const names = new Map(roster.map(({ session_id, display_name }) => [session_id, display_name]));
    const refreshSessionIds = new Set<string>();
    const deletedSessionIds: string[] = [];
    for (const [sessionId, document] of this.documents) {
      if (!names.has(sessionId)) {
        deletedSessionIds.push(sessionId);
      } else if (document.title !== cleanTitle(names.get(sessionId) ?? null)) {
        refreshSessionIds.add(sessionId);
      }
    }
    for (const row of roster) {
      if (!this.documents.has(row.session_id)) refreshSessionIds.add(row.session_id);
    }
    return {
      refreshSessionIds: [...refreshSessionIds].sort(),
      deletedSessionIds: deletedSessionIds.sort(),
    };
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
    const sessionIds = [...this.documents.keys()];
    const queryTerms = [...bigramCodePointFrequencies(query).keys()].sort(compareBigramTerms);
    const termIndexes = new Map(queryTerms.map((term, index) => [term, index]));
    const firstCharacters = new Uint8Array(Math.ceil(CODE_POINT_RADIX / 8));
    for (const term of queryTerms) {
      const first = Math.floor(term / CODE_POINT_RADIX);
      const byteIndex = first >>> 3;
      firstCharacters[byteIndex] = firstCharacters[byteIndex]! | (1 << (first & 7));
    }

    const documentFrequencies = new Uint32Array(queryTerms.length);
    const termCounts = new Uint32Array(queryTerms.length);
    const seenAtDocument = new Uint32Array(queryTerms.length);
    const touchedTerms: number[] = [];
    const postings = new SparseTermFrequencyBuffer();
    const offsets = new Uint32Array(sessionIds.length + 1);

    for (let ordinal = 0; ordinal < sessionIds.length; ordinal += 1) {
      const document = this.documents.get(sessionIds[ordinal]!)!;
      const generation = ordinal + 1;
      touchedTerms.length = 0;
      const codePoints = document.codePoints;
      for (let position = 1; position < codePoints.length; position += 1) {
        const first = codePoints[position - 1]!;
        if ((firstCharacters[first >>> 3]! & (1 << (first & 7))) === 0) continue;
        const termIndex = termIndexes.get(first * CODE_POINT_RADIX + codePoints[position]!);
        if (termIndex === undefined) continue;
        if (seenAtDocument[termIndex] !== generation) {
          seenAtDocument[termIndex] = generation;
          termCounts[termIndex] = 0;
          touchedTerms.push(termIndex);
        }
        termCounts[termIndex] = termCounts[termIndex]! + 1;
      }
      touchedTerms.sort((left, right) => left - right);
      for (const termIndex of touchedTerms) {
        documentFrequencies[termIndex] = documentFrequencies[termIndex]! + 1;
        postings.append(termIndex, termCounts[termIndex]!);
      }
      offsets[ordinal + 1] = postings.length;
    }

    const scores = new Float64Array(sessionIds.length);
    const averageLength = sessionIds.length ? this.totalBigramLength / sessionIds.length : 0;
    if (averageLength > 0) {
      for (let ordinal = 0; ordinal < sessionIds.length; ordinal += 1) {
        const document = this.documents.get(sessionIds[ordinal]!)!;
        const length = document.bigramLength;
        for (let posting = offsets[ordinal]!; posting < offsets[ordinal + 1]!; posting += 1) {
          const termIndex = postings.termIndexAt(posting);
          const frequency = postings.frequencyAt(posting);
          const documentFrequency = documentFrequencies[termIndex]!;
          const idf = Math.log(1 + (
            sessionIds.length - documentFrequency + 0.5
          ) / (documentFrequency + 0.5));
          const denominator = frequency + BM25_K1 * (
            1 - BM25_B + BM25_B * length / averageLength
          );
          scores[ordinal] = scores[ordinal]! + idf * frequency * (BM25_K1 + 1) / denominator;
        }
      }
    }

    const selected = topKOrdinals(sessionIds, scores, limit);
    return selected.map((ordinal) => ({
      session_id: sessionIds[ordinal]!,
      document: this.documents.get(sessionIds[ordinal]!)!,
      score: scores[ordinal]!,
    }));
  }

  private replace(record: SessionDocumentRecord): void {
    this.remove(record.session_id);
    const document = assembleSessionDocument(record);
    this.documents.set(record.session_id, document);
    this.totalBigramLength += document.bigramLength;
  }

  private remove(sessionId: string): void {
    const document = this.documents.get(sessionId);
    if (!document) return;
    this.totalBigramLength -= document.bigramLength;
    this.documents.delete(sessionId);
  }
}

class SparseTermFrequencyBuffer {
  private values = new Uint32Array(1_024);
  private used = 0;

  get length(): number {
    return this.used / 2;
  }

  append(termIndex: number, frequency: number): void {
    if (this.used + 2 > this.values.length) {
      const expanded = new Uint32Array(this.values.length * 2);
      expanded.set(this.values);
      this.values = expanded;
    }
    this.values[this.used] = termIndex;
    this.values[this.used + 1] = frequency;
    this.used += 2;
  }

  termIndexAt(index: number): number {
    return this.values[index * 2]!;
  }

  frequencyAt(index: number): number {
    return this.values[index * 2 + 1]!;
  }
}

function topKOrdinals(sessionIds: readonly string[], scores: Float64Array, limit: number): number[] {
  const capacity = Math.min(sessionIds.length, Math.max(0, limit));
  if (capacity === 0) return [];
  const heap = new Int32Array(capacity);
  let heapLength = 0;
  for (let ordinal = 0; ordinal < sessionIds.length; ordinal += 1) {
    if (heapLength < capacity) {
      heap[heapLength] = ordinal;
      siftUp(heap, heapLength, sessionIds, scores);
      heapLength += 1;
    } else if (isWorse(heap[0]!, ordinal, sessionIds, scores)) {
      heap[0] = ordinal;
      siftDown(heap, heapLength, 0, sessionIds, scores);
    }
  }
  return [...heap.slice(0, heapLength)].sort((left, right) =>
    scores[right]! - scores[left]!
      || (sessionIds[left]! < sessionIds[right]! ? -1 : sessionIds[left]! > sessionIds[right]! ? 1 : 0));
}

function siftUp(heap: Int32Array, index: number, ids: readonly string[], scores: Float64Array): void {
  let child = index;
  while (child > 0) {
    const parent = Math.floor((child - 1) / 2);
    if (!isWorse(heap[child]!, heap[parent]!, ids, scores)) return;
    [heap[child], heap[parent]] = [heap[parent]!, heap[child]!];
    child = parent;
  }
}

function siftDown(heap: Int32Array, length: number, index: number, ids: readonly string[], scores: Float64Array): void {
  let parent = index;
  while (true) {
    const left = parent * 2 + 1;
    const right = left + 1;
    let worse = parent;
    if (left < length && isWorse(heap[left]!, heap[worse]!, ids, scores)) worse = left;
    if (right < length && isWorse(heap[right]!, heap[worse]!, ids, scores)) worse = right;
    if (worse === parent) return;
    [heap[parent], heap[worse]] = [heap[worse]!, heap[parent]!];
    parent = worse;
  }
}

function isWorse(left: number, right: number, ids: readonly string[], scores: Float64Array): boolean {
  return scores[left]! < scores[right]!
    || (scores[left] === scores[right] && ids[left]! > ids[right]!);
}

function documentCodePoints(parts: readonly string[]): Uint32Array {
  let length = 0;
  for (const part of parts) {
    for (const character of part) if (!PYTHON_WHITESPACE.test(character)) length += 1;
  }
  const codePoints = new Uint32Array(length);
  let index = 0;
  for (const part of parts) {
    for (const character of part) {
      if (PYTHON_WHITESPACE.test(character)) continue;
      codePoints[index] = character.codePointAt(0)!;
      index += 1;
    }
  }
  return codePoints;
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
