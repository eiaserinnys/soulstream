// 마크다운 본문 요소의 className 정본 (카드 #1808).
// 완료 렌더(MarkdownContent)와 스트리밍 렌더(StreamingMarkdown)가 같은 모양을 쓰도록
// 두 곳이 이 상수를 함께 읽는다. Tailwind가 클래스를 스캔하므로 값은 완전한 리터럴
// 문자열이어야 하고, 조각을 이어 붙이거나 변수로 만들지 않는다.

export const markdownBlock = { "data-markdown-block": "true" } as const;
export const markdownBlockAttribute = 'data-markdown-block="true"';

export const defaultAnchorClass = "text-accent-blue hover:underline";
export const userBubbleAnchorClass =
  "text-white underline decoration-white/70 underline-offset-2 hover:decoration-white";

export const markdownParagraphClass = "mb-2 last:mb-0";
export const markdownH1Class = "text-xl font-bold mb-2 mt-3 first:mt-0";
export const markdownH2Class = "text-base font-bold mb-2 mt-3 first:mt-0";
export const markdownH3Class = "text-base font-bold mb-1.5 mt-2 first:mt-0";
export const markdownH4Class = "text-base font-semibold mb-1 mt-2 first:mt-0";
export const markdownUnorderedListClass = "mb-2 last:mb-0 ml-4 list-disc";
export const markdownOrderedListClass = "mb-2 last:mb-0 ml-4 list-decimal";
export const markdownListItemClass = "mb-0.5";
export const markdownTaskListItemClass = "mb-0.5 list-none -ml-4";
export const markdownCheckboxClass = "mt-1 mr-1.5 accent-accent-blue pointer-events-none";
export const markdownBarePreClass = "text-xs text-muted-foreground bg-input rounded-floor px-2 py-1.5 my-1.5 whitespace-pre-wrap break-words overflow-auto max-h-60 font-mono";
export const markdownInlineCodeClass = "text-xs bg-input rounded-mark px-1 py-0.5 font-mono";
export const markdownStrongClass = "font-bold";
export const markdownEmphasisClass = "italic";
export const markdownDeletedClass = "text-muted-foreground line-through";
export const markdownRuleClass = "border-border my-3";
export const markdownBlockquoteClass = "border-l-2 border-muted-foreground/30 pl-3 my-2 text-muted-foreground italic";
// 인용문 복사 단추 자리(pr-9)까지 완료 렌더와 같은 폭을 쓴다. 위 기본 클래스에 pr-9를 더한 값이다.
export const markdownBlockquoteCopyClass = "border-l-2 border-muted-foreground/30 pl-3 my-2 text-muted-foreground italic pr-9";
export const markdownBlockquoteFrameClass = "group/blockquote relative";
export const markdownTableWrapperClass = "overflow-auto my-2 rounded-floor border border-border bg-card";
export const markdownTableFocusClass = "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";
export const markdownTableClass = "text-xs border-collapse w-full";
export const markdownTableHeaderCellClass = "border border-border px-2 py-1 text-left font-semibold bg-input text-foreground";
export const markdownTableCellClass = "border border-border px-2 py-1 text-foreground";

// 코드 블록: 복사 단추 자리(pr-9, min-h-9)까지 완료 렌더와 같은 틀을 쓴다.
export const markdownCodeBlockFrameClass = "group/codeblock relative";
export const markdownCodeBlockClass = "text-xs text-muted-foreground bg-input rounded-floor px-2 py-2.5 pr-9 min-h-9 my-1.5 whitespace-pre-wrap break-words overflow-auto max-h-60 font-mono";

// 스트리밍 본문 감싸개. 완료 본문과 같은 클래스로 그려 완료 순간 자리가 바뀌지 않는다.
export const markdownBodyClass = "text-base text-foreground";
export const markdownManuscriptBodyClass = "[line-height:1.6] [word-break:var(--locale-word-break,keep-all)] [overflow-wrap:anywhere]";
export const markdownPlainBodyClass = "break-words leading-snug";

// words 모듈을 받기 전에만 쓰는 평문 스트리밍 모양(지금 동작 그대로).
export const markdownStreamingFallbackBodyClass = "text-base text-foreground whitespace-pre-wrap";
export const markdownStreamingFallbackManuscriptTextClass = "[line-height:1.6] [word-break:var(--locale-word-break,keep-all)] [overflow-wrap:anywhere]";
export const markdownStreamingFallbackTextClass = "leading-snug [word-break:var(--locale-word-break,keep-all)] [overflow-wrap:anywhere]";
export const markdownStreamingCursorClass = "inline-block w-1.5 h-3.5 bg-foreground/60 ml-0.5 align-text-bottom animate-caret-blink";
