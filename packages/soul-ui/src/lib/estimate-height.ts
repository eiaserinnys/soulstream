/**
 * ChatView virtualizer 높이 예측 모듈
 *
 * @chenglou/pretext를 사용하여 DOM reflow 없이 메시지 높이를 계산한다.
 * 각 메시지 컴포넌트의 CSS 레이아웃(padding, margin, font, line-height)을
 * JS 상수로 미러링하여 정확한 높이를 예측한다.
 *
 * 컴포넌트 CSS가 변경되면 이 파일의 상수도 함께 갱신해야 한다.
 */

import { prepare, layout } from "@chenglou/pretext";
import type { PreparedText } from "@chenglou/pretext";
import type { MessageOrGroup } from "./grouping";
import type { ChatMessage } from "./flatten-tree";

// ─── CSS 레이아웃 상수 ─────────────────────────────────────

const FONT_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const FONT_MONO = '"Cascadia Code", "Fira Code", monospace';

export const FONT = {
  base: `16px ${FONT_SANS}`,
  baseBold: `bold 16px ${FONT_SANS}`,
  sm: `14px ${FONT_SANS}`,
  xs: `12px ${FONT_SANS}`,
  xsMono: `12px ${FONT_MONO}`,
  xl: `20px ${FONT_SANS}`,
  xlBold: `bold 20px ${FONT_SANS}`,
} as const;

export const LINE_HEIGHT = {
  baseSnug: 22,  // text-base leading-snug (16 * 1.375)
  base: 24,      // text-base (16 * 1.5)
  sm: 20,        // text-sm (14 * ~1.43)
  xs: 16,        // text-xs (12 * ~1.33)
} as const;

/**
 * Padding / spacing constants mirrored from Tailwind utility classes.
 * px-3 = 12px each side, py-1 = 4px each side, etc.
 */
export const PAD = {
  outerX: 12,        // px-3
  outerY: 4,         // py-1 (각 방향 — 총 8px)
  outerYCompact: 2,  // py-0.5 (각 방향 — 총 4px)
  avatarW: 32,       // w-8
  gap: 8,            // gap-2
  headerMb: 2,       // mb-0.5
  innerX: 8,         // px-2
  innerY: 4,         // py-1
} as const;

/** outer padding + avatar + gap을 제외한 콘텐츠 가용 너비 */
export function contentWidthFrom(containerWidth: number): number {
  // 2*outerX(24) + avatarW(32) + gap(8) = 64
  return Math.max(containerWidth - 64, 100);
}

// ─── prepare 캐시 ────────────────────────────────────────

const prepareCache = new Map<string, { prepared: PreparedText; text: string }>();

function cachedPrepare(key: string, text: string, font: string): PreparedText {
  const cached = prepareCache.get(key);
  if (cached && cached.text === text) return cached.prepared;
  const prepared = prepare(text, font);
  prepareCache.set(key, { prepared, text });
  return prepared;
}

export function clearPrepareCache(): void {
  prepareCache.clear();
}

// ─── 텍스트 높이 계산 ────────────────────────────────────

function textHeight(
  text: string,
  font: string,
  lineHeight: number,
  width: number,
  key: string,
): number {
  if (!text) return 0;
  const prepared = cachedPrepare(key, text, font);
  return layout(prepared, width, lineHeight).height;
}

// ─── 마크다운 블록 파서 ──────────────────────────────────

export type MdBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { type: "code"; text: string }
  | { type: "list"; items: string[] }
  | { type: "blockquote"; text: string }
  | { type: "hr" }
  | { type: "table"; rows: number };

/**
 * 마크다운 텍스트를 블록 단위로 분리한다.
 * ReactMarkdown의 렌더링을 100% 재현하는 것이 아니라,
 * 높이에 영향을 주는 블록 구조를 파악하는 것이 목적.
 */
export function parseMarkdownBlocks(md: string): MdBlock[] {
  if (!md) return [];

  const blocks: MdBlock[] = [];
  const lines = md.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 빈 줄 건너뛰기
    if (line.trim() === "") {
      i++;
      continue;
    }

    // 코드 블록: ```...```
    if (line.trimStart().startsWith("```")) {
      const codeLines: string[] = [];
      i++; // ``` 여는 줄 넘기기
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // ``` 닫는 줄 넘기기
      blocks.push({ type: "code", text: codeLines.join("\n") });
      continue;
    }

    // HR: ---
    if (/^-{3,}\s*$/.test(line) || /^\*{3,}\s*$/.test(line) || /^_{3,}\s*$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // 헤딩: # ~ ####
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        level: headingMatch[1].length as 1 | 2 | 3 | 4,
        text: headingMatch[2],
      });
      i++;
      continue;
    }

    // 테이블: |로 시작하는 연속 줄
    if (line.trimStart().startsWith("|")) {
      let rowCount = 0;
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        // 구분선(|---|---|)은 높이에 기여하지만 행 수에 포함
        rowCount++;
        i++;
      }
      blocks.push({ type: "table", rows: rowCount });
      continue;
    }

    // 리스트: - / * / + / 1. 로 시작하는 연속 줄
    if (/^\s*[-*+]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (
        i < lines.length &&
        (/^\s*[-*+]\s/.test(lines[i]) || /^\s*\d+\.\s/.test(lines[i]))
      ) {
        // 리스트 마커 제거
        items.push(lines[i].replace(/^\s*[-*+]\s+/, "").replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    // 인용: > 로 시작하는 연속 줄
    if (line.trimStart().startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith(">")) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ type: "blockquote", text: quoteLines.join("\n") });
      continue;
    }

    // 나머지: paragraph (빈 줄까지 연속)
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trimStart().startsWith("```") &&
      !lines[i].trimStart().startsWith("#") &&
      !lines[i].trimStart().startsWith("|") &&
      !lines[i].trimStart().startsWith(">") &&
      !/^\s*[-*+]\s/.test(lines[i]) &&
      !/^\s*\d+\.\s/.test(lines[i]) &&
      !/^-{3,}\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: "paragraph", text: paraLines.join("\n") });
    }
  }

  return blocks;
}

// ─── 마크다운 높이 계산 ──────────────────────────────────

export function markdownHeight(
  md: string,
  contentWidth: number,
  cachePrefix: string,
): number {
  if (!md) return 0;

  const blocks = parseMarkdownBlocks(md);
  let total = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    switch (block.type) {
      case "paragraph":
        total += textHeight(
          block.text,
          FONT.base,
          LINE_HEIGHT.baseSnug,
          contentWidth,
          `${cachePrefix}-p-${i}`,
        );
        total += 8; // mb-2
        break;

      case "heading": {
        const font = block.level === 1 ? FONT.xlBold : FONT.baseBold;
        const lh = block.level === 1 ? LINE_HEIGHT.base + 4 : LINE_HEIGHT.base;
        total += textHeight(
          block.text,
          font,
          lh,
          contentWidth,
          `${cachePrefix}-h-${i}`,
        );
        // h1: text-xl font-bold mb-2(8) mt-3(12) → 20
        // h2: text-base font-bold mb-2(8) mt-3(12) → 20
        // h3: text-base font-bold mb-1.5(6) mt-2(8) → 14
        // h4: text-base font-semibold mb-1(4) mt-2(8) → 12
        total += block.level <= 2 ? 20 : block.level === 3 ? 14 : 12;
        break;
      }

      case "code": {
        // pre: text-xs mono, px-2(16 total) py-1.5(12 total), max-h-60(240px)
        // max-h-60은 pre 요소 전체(padding 포함)에 적용되므로 cap은 240px
        const codeH = textHeight(
          block.text,
          FONT.xsMono,
          LINE_HEIGHT.xs,
          contentWidth - 16, // px-2 양쪽 = 16
          `${cachePrefix}-code-${i}`,
        );
        total += Math.min(codeH + 12, 240); // py-1.5(12) 포함, max-h-60(240) cap
        total += 12; // my-1.5 상하 여백
        break;
      }

      case "list":
        for (let j = 0; j < block.items.length; j++) {
          total += textHeight(
            block.items[j],
            FONT.base,
            LINE_HEIGHT.baseSnug,
            contentWidth - 16, // ml-4
            `${cachePrefix}-li-${i}-${j}`,
          );
          total += 2; // mb-0.5
        }
        total += 8; // mb-2
        break;

      case "blockquote":
        // border-l-2 pl-3 my-2 → 내부 너비 = contentWidth - 12(pl-3)
        total += textHeight(
          block.text,
          FONT.base,
          LINE_HEIGHT.baseSnug,
          contentWidth - 12,
          `${cachePrefix}-bq-${i}`,
        );
        total += 16; // my-2 (상 8 + 하 8)
        break;

      case "hr":
        total += 24 + 1; // my-3(24) + border(1)
        break;

      case "table":
        total += block.rows * 28 + 16; // 행당 ~28px + my-2(16)
        break;
    }
  }

  // 마지막 블록의 하단 여백은 실제로 소비되지 않을 수 있으나, 작은 오차.
  return Math.max(total, 0);
}

// ─── 메시지 타입별 높이 추정 ─────────────────────────────

/**
 * CollapsibleContent 접힌 상태 높이.
 * button(sm) + pre 3줄(xs mono) + padding.
 */
function collapsibleCollapsedHeight(content: string): number {
  const lines = (content || "").split("\n");
  const needsCollapse = lines.length > 3;
  const preLineCount = needsCollapse ? 3 : lines.length;
  // pre: text-xs mono, px-2(16) py-1.5(12)
  const preH = preLineCount * LINE_HEIGHT.xs + 12;
  // button(needsCollapse) 또는 span: text-sm leading ~20px + mb-0.5(2)
  const labelH = LINE_HEIGHT.sm + 2;
  return labelH + preH;
}

/** SystemMessage (error, result, system, complete) */
function estimateSystemMessage(msg: ChatMessage, contentWidth: number): number {
  const outerPadY = 2 * PAD.outerY; // py-1 = 8

  // complete with CollapsibleContent
  const isComplete = msg.treeNodeType === "complete";
  if (isComplete && msg.content && msg.content !== "Turn completed") {
    return outerPadY + collapsibleCollapsedHeight(msg.content);
  }

  // 일반 system (error / result / compact / 기타)
  // inner: px-2(16) py-1(8) + text-xs + text-center
  const innerPadY = 2 * PAD.innerY; // 8
  const innerWidth = contentWidth - 2 * PAD.innerX; // px-2 양쪽 = 16
  const textH = textHeight(
    msg.content,
    FONT.xs,
    LINE_HEIGHT.xs,
    innerWidth,
    `sys-${msg.id}`,
  );
  return outerPadY + innerPadY + textH;
}

/** AssistantMessage: header + markdown content */
function estimateAssistantMessage(msg: ChatMessage, contentWidth: number): number {
  const outerPadY = 2 * PAD.outerY; // 8
  const headerH = LINE_HEIGHT.base + PAD.headerMb; // 24 + 2 = 26

  let contentH: number;
  if (msg.isStreaming) {
    // 스트리밍 중: pre-wrap 텍스트
    contentH = textHeight(
      msg.content,
      FONT.base,
      LINE_HEIGHT.baseSnug,
      contentWidth,
      `ast-stream-${msg.id}`,
    );
  } else {
    contentH = markdownHeight(msg.content, contentWidth, `ast-${msg.id}`);
  }

  return outerPadY + headerH + contentH;
}

/** UserMessage: AssistantMessage와 동일 + optional ContextBlock */
function estimateUserMessage(msg: ChatMessage, contentWidth: number): number {
  const base = estimateAssistantMessage(msg, contentWidth);
  // ContextBlock 접힌 상태: mt-1.5(6) + button text-sm(20) = 26px
  const contextH = msg.contextItems && msg.contextItems.length > 0 ? 26 : 0;
  return base + contextH;
}

/** InterventionMessage: header + pre-wrap text */
function estimateInterventionMessage(msg: ChatMessage, contentWidth: number): number {
  const outerPadY = 2 * PAD.outerY; // 8
  const headerH = LINE_HEIGHT.base + PAD.headerMb; // 26
  const contentH = textHeight(
    msg.content,
    FONT.base,
    LINE_HEIGHT.baseSnug,
    contentWidth,
    `intv-${msg.id}`,
  );
  return outerPadY + headerH + contentH;
}

/** ThinkingMessage: 항상 접힌 상태로 추정 */
function estimateThinkingMessage(msg: ChatMessage): number {
  const outerPadY = 2 * PAD.outerY; // 8
  return outerPadY + collapsibleCollapsedHeight(msg.content);
}

/** ChatInputRequest: label + optional header + question + buttons/status */
function estimateInputRequest(msg: ChatMessage, contentWidth: number): number {
  const outerPadY = 2 * PAD.outerY; // 8
  const labelH = LINE_HEIGHT.xs + 4; // "Claude가 질문합니다" + mb-1
  const question = msg.questions?.[0];
  const headerH = question?.header ? LINE_HEIGHT.xs + 4 : 0; // optional header + mb-1
  const questionTextH = question
    ? textHeight(
        question.question,
        FONT.base,
        LINE_HEIGHT.base,
        contentWidth,
        `ir-q-${msg.id}`,
      ) + 8 // mb-2
    : 0;
  const buttonsH = 28; // 버튼 행 또는 상태 텍스트
  return outerPadY + labelH + headerH + questionTextH + buttonsH;
}

// ─── 디스패처 ────────────────────────────────────────────

/**
 * MessageOrGroup의 예상 높이를 반환한다.
 * @param item - grouped 배열의 항목
 * @param containerWidth - 스크롤 컨테이너의 현재 너비
 */
export function estimateItemHeight(item: MessageOrGroup, containerWidth: number): number {
  if (item.type === "tool-group") {
    // 접힌 상태: py-0.5(4) + button text-sm(20) = 24
    return 24;
  }

  const msg = item.msg;
  const cw = contentWidthFrom(containerWidth);

  switch (msg.role) {
    case "system":
      return estimateSystemMessage(msg, cw);
    case "assistant":
      return msg.treeNodeType === "thinking"
        ? estimateThinkingMessage(msg)
        : estimateAssistantMessage(msg, cw);
    case "user":
      return estimateUserMessage(msg, cw);
    case "intervention":
      return estimateInterventionMessage(msg, cw);
    case "tool":
      // 단독 tool: py-0.5(4) + text-xs 1줄(16) = 20
      return 20;
    case "system_message":
      // SystemPromptMessage 접힌: py-1(8) + button text-sm(20) = 28
      return 28;
    case "input_request":
      return estimateInputRequest(msg, cw);
    case "away_summary":
      // recap: py-2(16) + text-sm 여러 줄 — 시스템 메시지와 유사하게 추정
      return estimateSystemMessage(msg, cw);
    default:
      return 80;
  }
}
