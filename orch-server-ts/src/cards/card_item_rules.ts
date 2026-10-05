export type CardItemDisplay = "todo" | "doing" | "reported" | "changed" | "fix" | "confirmed" | "dropped";
export type CardItemState = "todo" | "doing" | "done" | "dropped";
export type CardItemEvidence = { type: "image" | "link"; url: string; label: string };
export type CardItemSource = { commentId: string; kind: "comment" | "spoken"; at: string };
export type CardItem = {
  id: number;
  title: string;
  state: CardItemState;
  result: string | null;
  evidence: CardItemEvidence[];
  caveat: string | null;
  rev: number;
  confirmed: { at: string; rev: number } | null;
  fixOpen: number;
  reopened: string | null;
  from: CardItemSource | null;
  createdAt: string;
  reportedAt: string | null;
};
export type CardNowTurn = "agent" | "user" | "outside";
export type CardNow = {
  text: string;
  turn: CardNowTurn;
  ask: string | null;
  updatedAt: string;
  sessionId: string | null;
};

const IDENTIFIER_MESSAGE = "식별자는 노트에 적으세요(add_card_note). 링크는 증거에 다세요";
const RESULT_REQUIRED_MESSAGE = "결과 한 줄(result)이 필요합니다";
const FIX_CONFIRMED_MESSAGE = "사용자가 확인한 항목입니다. 고치려면 reopen_reason에 까닭을 적으세요";
const DROP_CONFIRMED_MESSAGE = "사용자가 확인한 항목은 뺄 수 없습니다";
const ASK_REQUIRED_MESSAGE = "사용자가 볼 것을 ask에 한 줄로 적으세요";

const commitWord = /(?<![A-Za-z0-9_])(?=[0-9a-f]{7,40}(?![A-Za-z0-9_]))(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![A-Za-z0-9_])/i;
const uuidWord = /(?<![A-Za-z0-9_])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![A-Za-z0-9_])/i;
const urlText = /(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|www\.)\S+/i;
const slashFile = /(?:[A-Za-z]:)?[^\s<>"'`]+[\/\\][^\s<>"'`]*\.[A-Za-z0-9]{1,12}(?=$|[^A-Za-z0-9_])/;
const codeFile = /(?<![A-Za-z0-9_])[A-Za-z0-9_가-힣.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|pyi|sql|sh|bash|zsh|ps1|c|cc|cpp|h|hpp|cs|go|rs|java|kt|kts|swift|dart|rb|php|vue|svelte|html|css|scss|sass|less)(?![A-Za-z0-9_])/i;

function invalidCardRequest(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 422, code: "INVALID_CARD_REQUEST" });
}

function rejectIdentifier(text: string): void {
  if (commitWord.test(text) || uuidWord.test(text) || urlText.test(text) || slashFile.test(text) || codeFile.test(text))
    invalidCardRequest(IDENTIFIER_MESSAGE);
}

function checkOptionalShortText(field: string, text: string, max: number): string {
  const length = codePointLength(text);
  if (length > max) invalidCardRequest(`${field}은 ${max}자까지입니다. 지금 ${length}자입니다`);
  if (text.length > 0) rejectIdentifier(text);
  return text;
}

function requireResult(text: string | undefined): string {
  if (text === undefined || text.trim().length === 0) invalidCardRequest(RESULT_REQUIRED_MESSAGE);
  return assertShortCardText("result", text, 80);
}

function itemIndex(items: readonly CardItem[], itemId: number): number {
  const index = items.findIndex((candidate) => candidate.id === itemId);
  if (index < 0) invalidCardRequest("항목을 찾을 수 없습니다");
  return index;
}

function replaceItem(items: readonly CardItem[], index: number, updated: CardItem): CardItem[] {
  return items.map((candidate, candidateIndex) => candidateIndex === index ? updated : candidate);
}

export function codePointLength(text: string): number {
  return [...text].length;
}

export function assertShortCardText(field: string, text: string, max: number): string {
  if (text.trim().length === 0) invalidCardRequest(`${field}은 비워 둘 수 없습니다`);
  const length = codePointLength(text);
  if (length > max) invalidCardRequest(`${field}은 ${max}자까지입니다. 지금 ${length}자입니다`);
  rejectIdentifier(text);
  return text;
}

export function getCardItemDisplay(item: CardItem): CardItemDisplay {
  if (item.state === "dropped") return "dropped";
  if (item.confirmed !== null) return "confirmed";
  if (item.fixOpen > 0) return "fix";
  if (item.state === "doing") return "doing";
  if (item.state === "done" && item.reopened !== null) return "changed";
  if (item.state === "done") return "reported";
  return "todo";
}

export function setCardItems(current: readonly CardItem[], titles: readonly string[], at: string): CardItem[] {
  if (titles.length < 1 || titles.length > 6)
    invalidCardRequest("확인 항목은 하나에서 여섯까지입니다");
  if (current.some((item) => item.result !== null || item.confirmed !== null || item.fixOpen > 0 || item.state === "done" || item.state === "dropped"))
    invalidCardRequest("이미 결과나 확인이 달린 항목이 있습니다. 새 항목은 add_card_item으로 더하세요");

  const firstId = current.length === 0 ? 1 : Math.max(...current.map(({ id }) => id)) + 1;
  return titles.map((title, index) => ({
    id: firstId + index,
    title: assertShortCardText("title", title, 40),
    state: "todo",
    result: null,
    evidence: [],
    caveat: null,
    rev: 0,
    confirmed: null,
    fixOpen: 0,
    reopened: null,
    from: null,
    createdAt: at,
    reportedAt: null,
  }));
}

export function addCardItem(current: readonly CardItem[], title: string, source: CardItemSource | null, at: string): CardItem[] {
  if (!source || !source.commentId || (source.kind !== "comment" && source.kind !== "spoken"))
    invalidCardRequest("항목은 사용자의 글에서만 더할 수 있습니다. from_comment_id에 사용자 커멘트를 지정하세요");
  const unconfirmedCount = current.filter((item) => {
    const display = getCardItemDisplay(item);
    return display !== "confirmed" && display !== "dropped";
  }).length;
  if (unconfirmedCount >= 6)
    invalidCardRequest("확인하지 않은 항목이 여섯입니다. 사용자의 확인을 기다리세요");
  const id = current.length === 0 ? 1 : Math.max(...current.map(({ id: currentId }) => currentId)) + 1;
  return [...current, {
    id,
    title: assertShortCardText("title", title, 40),
    state: "todo",
    result: null,
    evidence: [],
    caveat: null,
    rev: 0,
    confirmed: null,
    fixOpen: 0,
    reopened: null,
    from: { ...source },
    createdAt: at,
    reportedAt: null,
  }];
}

export type ReportCardItemInput = {
  state: Exclude<CardItemState, "todo">;
  result?: string;
  evidence?: CardItemEvidence[];
  caveat?: string;
  reopenReason?: string;
};

export function reportCardItem(current: readonly CardItem[], itemId: number, input: ReportCardItemInput, at: string): CardItem[] {
  const index = itemIndex(current, itemId);
  const existing = current[index]!;
  if (existing.confirmed !== null && input.state === "dropped") invalidCardRequest(DROP_CONFIRMED_MESSAGE);
  if (existing.confirmed !== null && (!input.reopenReason || input.reopenReason.trim().length === 0))
    invalidCardRequest(FIX_CONFIRMED_MESSAGE);

  const result = input.result === undefined
    ? existing.result
    : checkOptionalShortText("result", input.result, 80);
  if ((input.state === "done" || input.state === "dropped") && (input.result === undefined || input.result.trim().length === 0))
    requireResult(input.result);

  const caveat = input.caveat === undefined ? existing.caveat : checkOptionalShortText("caveat", input.caveat, 60);
  let evidence = existing.evidence;
  if (input.evidence !== undefined) {
    if (input.evidence.length > 4) invalidCardRequest("증거는 넷까지입니다");
    evidence = input.evidence.map((proof) => ({
      ...proof,
      label: assertShortCardText("evidence.label", proof.label, 40),
    }));
  }

  const reopenReason = existing.confirmed !== null
    ? assertShortCardText("reopen_reason", input.reopenReason!, 80)
    : existing.reopened;
  const updated: CardItem = {
    ...existing,
    state: input.state,
    result,
    evidence,
    caveat,
    confirmed: existing.confirmed !== null ? null : existing.confirmed,
    reopened: reopenReason,
    ...(input.state === "done" ? { rev: existing.rev + 1, reportedAt: at, fixOpen: 0 } : {}),
    ...(input.state === "dropped" ? { reportedAt: at } : {}),
  };
  return replaceItem(current, index, updated);
}

export function confirmCardItem(current: readonly CardItem[], itemId: number, confirmed: boolean, at: string): CardItem[] {
  const index = itemIndex(current, itemId);
  const existing = current[index]!;
  if (existing.state === "dropped") invalidCardRequest("뺀 항목은 확인할 수 없습니다");
  const updated: CardItem = confirmed
    ? { ...existing, confirmed: { at, rev: existing.rev }, reopened: null, fixOpen: 0 }
    : { ...existing, confirmed: null };
  return replaceItem(current, index, updated);
}

export function openCardItemFix(current: readonly CardItem[], itemId: number): CardItem[] {
  const index = itemIndex(current, itemId);
  const existing = current[index]!;
  return replaceItem(current, index, { ...existing, confirmed: null, fixOpen: existing.fixOpen + 1 });
}

export type MakeCardNowInput = { text: string; turn: CardNowTurn; ask?: string };

export function makeCardNow(input: MakeCardNowInput, at: string, sessionId: string | null): CardNow {
  const text = assertShortCardText("now", input.text, 60);
  if (input.turn === "user" && (input.ask === undefined || input.ask.trim().length === 0))
    invalidCardRequest(ASK_REQUIRED_MESSAGE);
  const ask = input.ask === undefined ? null : assertShortCardText("ask", input.ask, 60);
  return { text, turn: input.turn, ask, updatedAt: at, sessionId };
}

export function reviewCardNow(current: CardNow | null, ask: string | undefined, at: string, sessionId: string | null): CardNow | null {
  if (ask === undefined) return current;
  const checkedAsk = assertShortCardText("ask", ask, 60);
  return {
    text: current?.text ?? checkedAsk,
    turn: "user",
    ask: checkedAsk,
    updatedAt: at,
    sessionId,
  };
}

export function questionCardNow(current: CardNow | null, text: string, at: string, sessionId: string | null): CardNow | null {
  if (current === null) return null;
  const chars = [...text];
  const ask = chars.length <= 60 ? text : `${chars.slice(0, 59).join("")}…`;
  return { ...current, turn: "user", ask, updatedAt: at, sessionId };
}
