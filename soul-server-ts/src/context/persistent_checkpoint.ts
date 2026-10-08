import {
  formatCardReference,
  type GenerationCheckpointMaterial,
  type GenerationCheckpointReadLimits,
  type SupervisedCardSnapshot,
} from "@soulstream/mcp-contract";
import { estimateClaudeTextTokens, truncateClaudeTextToEstimatedTokens } from "../task/claude_context_recovery.js";
import type { ContextItem } from "./prompt_assembler.js";

export type { GenerationCheckpointMaterial, GenerationCheckpointReadLimits, SupervisedCardSnapshot };

export interface PersistentCheckpointBudget {
  totalTokens: number;
  stateTokens: number;
  narrativeTokens: number;
  summaryTokens: number;
  recentMinimumTokens: number;
  childSessionTokens: number;
  openQuestionTokens: number;
  cardLimit: number;
  questionLimit: number;
  recentEventLimit: number;
  unsummarizedEventLimit: number;
}

export interface PersistentCheckpointStats {
  estimatedTokens: number;
  chars: number;
  sections: {
    state: number;
    story: number;
    summaries: number;
    recent: number;
  };
  summarizedThroughTurn: number | null;
  recentFromEventId: number | null;
  recentToEventId: number | null;
}

export const PERSISTENT_CHECKPOINT_BUDGET: PersistentCheckpointBudget = {
  totalTokens: 20_000,
  stateTokens: 1_500,
  narrativeTokens: 2_500,
  summaryTokens: 5_000,
  recentMinimumTokens: 4_000,
  childSessionTokens: 300,
  openQuestionTokens: 300,
  cardLimit: 60,
  questionLimit: 10,
  recentEventLimit: 200,
  unsummarizedEventLimit: 200,
};

export const PERSISTENT_CHECKPOINT_READ_LIMITS: GenerationCheckpointReadLimits = {
  recentEventLimit: PERSISTENT_CHECKPOINT_BUDGET.recentEventLimit,
  unsummarizedEventLimit: PERSISTENT_CHECKPOINT_BUDGET.unsummarizedEventLimit,
};

export const PERSISTENT_SUPERVISION_SCOPE: { folderIds: string[] | null } = {
  folderIds: null,
};

const CHECKPOINT_HEAD = "이전 턴의 자세한 원문은 expand_session_turn 도구로 확인할 수 있습니다. "
  + "`#412`, `#412.s2` 같은 번호는 도구의 `card_id`, `session_id` 인자에 그대로 쓸 수 있습니다.";

export function buildPersistentCheckpoint(
  input: {
    material: GenerationCheckpointMaterial;
    cards: SupervisedCardSnapshot;
    standingInstructions: string[];
    ownSessionId: string;
    resetContext?: boolean;
    keepInstructions?: boolean;
  },
  budget: PersistentCheckpointBudget = PERSISTENT_CHECKPOINT_BUDGET,
): { item: ContextItem; stats: PersistentCheckpointStats } {
  const resetContext = input.resetContext === true;
  const state = buildStateSection(input.material, input.cards, input.ownSessionId, budget);
  const instructions = input.keepInstructions === false
    ? ""
    : buildInstructionsSection(input.standingInstructions);
  const requiredText = joinSections([
    ...(resetContext ? [] : [CHECKPOINT_HEAD]),
    state,
    instructions,
  ]);
  const requiredTokens = estimateClaudeTextTokens(requiredText);
  let story = "";
  let summaries = "";
  let recent = { text: "", records: [] as GenerationCheckpointMaterial["recent"]["records"] };
  if (!resetContext && requiredTokens <= budget.totalTokens) {
    const remainingTokens = budget.totalTokens - requiredTokens;
    const reserveRecentTokens = input.material.recent.records.length > 0
      ? Math.min(budget.recentMinimumTokens, remainingTokens)
      : 0;
    story = buildStorySection(
      input.material.story.narrative,
      Math.min(
        budget.narrativeTokens,
        Math.max(0, remainingTokens - reserveRecentTokens - estimateClaudeTextTokens("\n\n")),
      ),
    );
    const prefixWithStory = joinSections([requiredText, story]);
    const remainingAfterStory = Math.max(
      0,
      budget.totalTokens - estimateClaudeTextTokens(prefixWithStory) - reserveRecentTokens,
    );
    summaries = buildSummarySection(
      input.material,
      Math.min(
        budget.summaryTokens,
        Math.max(0, remainingAfterStory - estimateClaudeTextTokens("\n\n")),
      ),
    );
    const prefixBeforeRecent = joinSections([prefixWithStory, summaries]);
    recent = buildRecentSection(
      input.material,
      Math.max(0, budget.totalTokens - estimateClaudeTextTokens(prefixBeforeRecent)),
      budget.totalTokens,
      prefixBeforeRecent,
      budget.recentMinimumTokens,
    );
  }
  const text = joinSections([
    ...(resetContext ? [] : [CHECKPOINT_HEAD]),
    state,
    instructions,
    story,
    summaries,
    recent.text,
  ]);
  const stats: PersistentCheckpointStats = {
    estimatedTokens: estimateClaudeTextTokens(text),
    chars: text.length,
    sections: {
      state: estimateClaudeTextTokens(state),
      story: estimateClaudeTextTokens(story),
      summaries: estimateClaudeTextTokens(summaries),
      recent: estimateClaudeTextTokens(recent.text),
    },
    summarizedThroughTurn: !resetContext && input.material.totals.turnSummaries > 0
      ? Math.max(0, input.material.totals.turnSummaries - input.material.story.unfoldedTurnSummaries.length)
      : null,
    recentFromEventId: recent.records[0]?.event_id ?? null,
    recentToEventId: recent.records.at(-1)?.event_id ?? null,
  };
  return {
    item: {
      key: "persistent_checkpoint",
      label: "퍼시스턴트 체크포인트",
      content: text,
    },
    stats,
  };
}

function buildStateSection(
  material: GenerationCheckpointMaterial,
  cards: SupervisedCardSnapshot,
  ownSessionId: string,
  budget: PersistentCheckpointBudget,
): string {
  const heading = "## 현재 상태";
  const counts = `실행 중 ${cards.counts.running} · 막힘 ${cards.counts.blocked} · 검수 대기 ${cards.counts.review} · 대기 ${cards.counts.queued} · 드래프트 ${cards.counts.todo}`;
  const stateParts = [heading, counts];
  const remainingAfterCounts = Math.max(0, budget.stateTokens - estimateClaudeTextTokens(joinSections(stateParts)));
  const childSection = buildChildSessionSection(
    material.childSessions,
    material.childSessionTotal,
    Math.min(budget.childSessionTokens, remainingAfterCounts),
  );
  if (childSection) stateParts.push(childSection);
  const remainingAfterChildren = Math.max(0, budget.stateTokens - estimateClaudeTextTokens(joinSections(stateParts)));
  const questionSection = buildOpenQuestionSection(
    cards.openQuestions,
    cards.openQuestionTotal,
    Math.min(budget.openQuestionTokens, remainingAfterChildren),
  );
  if (questionSection) stateParts.push(questionSection);
  const remainingForCards = Math.max(0, budget.stateTokens - estimateClaudeTextTokens(joinSections(stateParts)));
  const cardSection = buildCardSection(cards, ownSessionId, remainingForCards);
  if (cardSection) stateParts.push(cardSection);
  return joinSections(stateParts);
}

function buildChildSessionSection(
  children: GenerationCheckpointMaterial["childSessions"],
  total: number,
  tokenLimit: number,
): string {
  if (total === 0) return "";
  const heading = "내가 부른 실행 중 세션";
  const lines: string[] = [];
  for (const child of children) {
    const candidateLines = [...lines, formatChildSession(child)];
    const omitted = Math.max(0, total - candidateLines.length);
    const candidate = joinLines([heading, ...candidateLines, ...(omitted > 0 ? [`외 ${omitted}개`] : [])]);
    if (estimateClaudeTextTokens(candidate) > tokenLimit) break;
    lines.push(formatChildSession(child));
  }
  const omitted = Math.max(0, total - lines.length);
  return joinLines([heading, ...lines, ...(omitted > 0 ? [`외 ${omitted}개`] : [])]);
}

function formatChildSession(child: GenerationCheckpointMaterial["childSessions"][number]): string {
  const id = formatSession(child);
  const title = truncateCharacters(child.displayName ?? "이름 없음", 40);
  const owner = child.agentId ?? "미지정";
  const preset = child.modelPreset ?? "미지정";
  // `#412.s2` already names the card. Without it the card is written out in full.
  const card = child.reference == null && child.cardId ? ` · 카드 ${child.cardId}` : "";
  return `- ${id} 「${title}」 · ${owner} / ${preset}${card}`;
}

function buildOpenQuestionSection(
  questions: SupervisedCardSnapshot["openQuestions"],
  total: number,
  tokenLimit: number,
): string {
  if (total === 0) return "";
  const heading = "내가 묻고 답을 기다리는 질문";
  const lines: string[] = [];
  for (const question of questions.slice(0, 3)) {
    const candidateLine = formatOpenQuestion(question);
    const omitted = Math.max(0, total - lines.length - 1);
    const candidate = joinLines([heading, ...lines, candidateLine, ...(omitted > 0 ? [`외 ${omitted}개`] : [])]);
    if (estimateClaudeTextTokens(candidate) > tokenLimit) break;
    lines.push(candidateLine);
  }
  const omitted = Math.max(0, total - lines.length);
  return joinLines([heading, ...lines, ...(omitted > 0 ? [`외 ${omitted}개`] : [])]);
}

function formatOpenQuestion(question: SupervisedCardSnapshot["openQuestions"][number]): string {
  const card = formatCard({ id: question.cardId, number: question.cardNumber });
  return `- ${card} 「${truncateCharacters(question.cardTitle, 60)}」: ${truncateCharacters(question.text, 200)}`;
}

function buildCardSection(
  snapshot: SupervisedCardSnapshot,
  ownSessionId: string,
  tokenLimit: number,
): string {
  const heading = "감독 카드";
  const renderedByStatus = { running: 0, blocked: 0, review: 0, queued: 0 };
  const lines: string[] = [];
  for (const card of snapshot.cards) {
    const candidateLines = [...lines, formatSupervisedCard(card, ownSessionId)];
    const candidateRenderedByStatus = {
      ...renderedByStatus,
      [card.status]: renderedByStatus[card.status] + 1,
    };
    const omitted = getOmittedCardCounts(snapshot.counts, candidateRenderedByStatus);
    const marker = formatOmittedCards(omitted);
    const candidate = joinLines([heading, ...candidateLines, ...(marker ? [marker] : [])]);
    if (estimateClaudeTextTokens(candidate) > tokenLimit) break;
    lines.push(formatSupervisedCard(card, ownSessionId));
    renderedByStatus[card.status] += 1;
  }
  const marker = formatOmittedCards(getOmittedCardCounts(snapshot.counts, renderedByStatus));
  if (snapshot.cards.length === 0 && !marker) return "";
  return joinLines([heading, ...lines, ...(marker ? [marker] : [])]);
}

function getOmittedCardCounts(
  totals: SupervisedCardSnapshot["counts"],
  rendered: { running: number; blocked: number; review: number; queued: number },
) {
  return {
    running: Math.max(0, totals.running - rendered.running),
    blocked: Math.max(0, totals.blocked - rendered.blocked),
    review: Math.max(0, totals.review - rendered.review),
    queued: Math.max(0, totals.queued - rendered.queued),
  };
}

function formatOmittedCards(omitted: { running: number; blocked: number; review: number; queued: number }): string {
  const labels = [
    ["실행 중", omitted.running],
    ["막힘", omitted.blocked],
    ["검수 대기", omitted.review],
    ["대기", omitted.queued],
  ] as const;
  const details = labels.filter(([, count]) => count > 0).map(([label, count]) => `${label} ${count}`);
  const total = omitted.running + omitted.blocked + omitted.review + omitted.queued;
  return total > 0 ? `외 ${total}장 생략(${details.join(", ")})` : "";
}

function formatSupervisedCard(
  card: SupervisedCardSnapshot["cards"][number],
  ownSessionId: string,
): string {
  const id = formatCard(card);
  const title = truncateCharacters(card.title, 60);
  const status = card.status === "blocked"
    ? `막힘(${blockedReason(card.blockedKind)})`
    : card.status === "running" ? "실행 중"
      : card.status === "review" ? "검수 대기" : "대기";
  return `- ${id} 「${title}」 ${status} · 담당 ${formatAssignee(card.assignee, ownSessionId)}`;
}

function blockedReason(kind: SupervisedCardSnapshot["cards"][number]["blockedKind"]): string {
  if (kind === "question") return "질문";
  if (kind === "limit") return "한도";
  return "보고 없음";
}

function formatAssignee(
  assignee: SupervisedCardSnapshot["cards"][number]["assignee"],
  ownSessionId: string,
): string {
  if (assignee.kind === "human") return "사용자";
  if (assignee.kind === "agent") return assignee.agentId ?? "미지정";
  if (assignee.kind === "session") {
    if (assignee.sessionId === ownSessionId) return "이 세션";
    return assignee.agentId ?? "미지정";
  }
  return "미지정";
}

function buildInstructionsSection(instructions: string[]): string {
  const text = instructions.map((instruction) => instruction.trim()).filter(Boolean).join("\n");
  if (!text) return "";
  return joinLines(["## 지속 지시", text]);
}

function buildStorySection(narrative: string | null, tokenLimit: number): string {
  if (!narrative?.trim()) return "";
  const heading = "## 대화 줄거리";
  const section = joinLines([heading, narrative]);
  if (estimateClaudeTextTokens(section) <= tokenLimit) return section;
  const bodyTokenLimit = Math.max(0, tokenLimit - estimateClaudeTextTokens(`${heading}\n`));
  const body = truncateClaudeTextToEstimatedTokens(narrative, bodyTokenLimit, "persistent_checkpoint_story");
  if (!body) return "";
  const truncatedSection = joinLines([heading, body]);
  return estimateClaudeTextTokens(truncatedSection) <= tokenLimit ? truncatedSection : "";
}

function buildSummarySection(material: GenerationCheckpointMaterial, tokenLimit: number): string {
  const summaries = material.story.unfoldedTurnSummaries.map((summary) =>
    `T${summary.turnNumber}: ${summary.content}`);
  if (summaries.length === 0) return "";
  const heading = "## 미접힘 턴 요약";
  const kept: string[] = [];
  for (const summary of [...summaries].reverse()) {
    const candidateKept = [summary, ...kept];
    const omittedCount = summaries.length - candidateKept.length;
    const omission = omittedCount > 0 ? summaryOmission(material.story.unfoldedTurnSummaries, omittedCount) : "";
    const candidate = joinLines([heading, ...(omission ? [omission] : []), ...candidateKept]);
    if (estimateClaudeTextTokens(candidate) > tokenLimit) break;
    kept.unshift(summary);
  }
  const omitted = summaries.length - kept.length;
  const marker = omitted > 0 ? summaryOmission(material.story.unfoldedTurnSummaries, omitted) : "";
  const section = joinLines([heading, ...(marker ? [marker] : []), ...kept]);
  return estimateClaudeTextTokens(section) <= tokenLimit ? section : "";
}

function summaryOmission(
  summaries: GenerationCheckpointMaterial["story"]["unfoldedTurnSummaries"],
  omittedCount: number,
): string {
  const omitted = summaries.slice(0, omittedCount);
  const first = omitted[0]?.turnNumber;
  const last = omitted.at(-1)?.turnNumber;
  if (first === undefined || last === undefined) return "";
  return `T${first}–T${last} 생략`;
}

function buildRecentSection(
  material: GenerationCheckpointMaterial,
  recentTokenLimit: number,
  totalTokenLimit: number,
  prefixText: string,
  recentMinimumTokens: number,
): { text: string; records: GenerationCheckpointMaterial["recent"]["records"] } {
  const anchor = material.lastSummarizedFinalResponseEventId;
  const unsummarized = material.recent.records.filter((record) => anchor === null || record.event_id > anchor);
  const summarized = material.recent.records
    .filter((record) => anchor !== null && record.event_id <= anchor)
    .sort((left, right) => right.event_id - left.event_id);
  const records = [...unsummarized];
  while (
    summarized.length > 0
    && estimateClaudeTextTokens(formatRecentSection(records, [], 0)) < recentMinimumTokens
  ) {
    const candidate = summarized.shift();
    if (candidate) records.unshift(candidate);
  }

  const dropped: GenerationCheckpointMaterial["recent"]["records"] = [];
  let text = formatRecentSection(records, dropped, material.recent.omittedUnsummarized);
  while (
    records.length > 0
    && (estimateClaudeTextTokens(text) > recentTokenLimit
      || estimateClaudeTextTokens(joinSections([prefixText, text])) > totalTokenLimit)
  ) {
    const oldest = records.shift();
    if (oldest) dropped.push(oldest);
    text = formatRecentSection(records, dropped, material.recent.omittedUnsummarized);
  }
  if (
    estimateClaudeTextTokens(text) > recentTokenLimit
    || estimateClaudeTextTokens(joinSections([prefixText, text])) > totalTokenLimit
  ) {
    return { text: "", records: [] };
  }
  return { text, records };
}

function formatRecentSection(
  records: GenerationCheckpointMaterial["recent"]["records"],
  dropped: GenerationCheckpointMaterial["recent"]["records"],
  omittedUnsummarized: number,
): string {
  if (records.length === 0 && dropped.length === 0 && omittedUnsummarized === 0) return "";
  const omittedIds = dropped.map((record) => record.event_id);
  const omittedLines: string[] = [];
  if (omittedIds.length > 0) {
    const start = Math.min(...omittedIds);
    const end = Math.max(...omittedIds);
    omittedLines.push(`E${start}–E${end} 생략`);
  }
  if (omittedUnsummarized > 0) omittedLines.push(`외 ${omittedUnsummarized}개 미요약 이벤트 생략`);
  return joinLines([
    "## 최근 원문",
    ...omittedLines,
    ...records.map((record) => `E${record.event_id} · ${record.event_type}: ${record.text}`),
  ]);
}

// The number or reference is optional: a numberless card, or a central server older than card numbers,
// leaves it out, and the full ID is written instead.
function formatCard(card: { id: string; number?: number | null }): string {
  return typeof card.number === "number" ? formatCardReference(card.number) : card.id;
}

function formatSession(child: { sessionId: string; reference?: string | null }): string {
  return child.reference ?? child.sessionId;
}

function truncateCharacters(value: string, max: number): string {
  const characters = Array.from(value);
  if (characters.length <= max) return value;
  return `${characters.slice(0, Math.max(0, max - 1)).join("")}…`;
}

function joinLines(lines: string[]): string {
  return lines.filter(Boolean).join("\n");
}

function joinSections(sections: string[]): string {
  return sections.filter(Boolean).join("\n\n");
}
