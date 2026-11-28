import { useTranslation } from "react-i18next";
import { Children, cloneElement, createContext, isValidElement, useContext, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { Components } from "react-markdown";
import { cn } from "../lib/cn";
import "highlight.js/styles/github-dark.css";
import { DashboardIconCap } from "./DashboardIconCap";
import { MarkdownImage } from "./MarkdownImage";
import { useInternalLinkClick } from "./InternalLinkProvider";
import type { AttachmentReadContext } from "@soulstream/wire-schema/attachments";
import { contextualizeChatMarkdownImageSrc } from "../lib/chat-markdown-images";
import {
  defaultAnchorClass,
  markdownBlock,
  markdownBarePreClass,
  markdownBlockquoteClass,
  markdownBlockquoteCopyClass,
  markdownBlockquoteFrameClass,
  markdownCheckboxClass,
  markdownCodeBlockClass,
  markdownCodeBlockFrameClass,
  markdownDeletedClass,
  markdownEmphasisClass,
  markdownH1Class,
  markdownH2Class,
  markdownH3Class,
  markdownH4Class,
  markdownInlineCodeClass,
  markdownListItemClass,
  markdownOrderedListClass,
  markdownParagraphClass,
  markdownRuleClass,
  markdownStrongClass,
  markdownTableClass,
  markdownTableCellClass,
  markdownTableFocusClass,
  markdownTableHeaderCellClass,
  markdownTableWrapperClass,
  markdownTaskListItemClass,
  markdownUnorderedListClass,
  userBubbleAnchorClass,
} from "./markdown-classes";

export { defaultAnchorClass, markdownBlock, userBubbleAnchorClass };

export const createAnchorComponent = (className: string, readContext?: AttachmentReadContext): NonNullable<Components["a"]> => {
  const AnchorComponent: NonNullable<Components["a"]> = ({ children, onClick, href, ...props }) => {
    const internalLinkClick = useInternalLinkClick();
    return (
      <a
        className={className}
        target="_blank"
        rel="noopener noreferrer"
        {...props}
        href={href ? contextualizeChatMarkdownImageSrc(href, readContext) : href}
        onClick={(event) => {
          onClick?.(event);
          internalLinkClick(event);
        }}
      >
        {children}
      </a>
    );
  };
  return AnchorComponent;
};

const defaultAnchor = createAnchorComponent(defaultAnchorClass);
const userBubbleAnchor = createAnchorComponent(userBubbleAnchorClass);

export const components: Components = {
  p: ({ children }) => <p {...markdownBlock} className={markdownParagraphClass}>{children}</p>,
  h1: ({ children }) => (
    <h1 {...markdownBlock} className={markdownH1Class}>{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 {...markdownBlock} className={markdownH2Class}>{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 {...markdownBlock} className={markdownH3Class}>{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 {...markdownBlock} className={markdownH4Class}>{children}</h4>
  ),
  h5: ({ children }) => <h5 {...markdownBlock}>{children}</h5>,
  h6: ({ children }) => <h6 {...markdownBlock}>{children}</h6>,

  ul: ({ children }) => <ul {...markdownBlock} className={markdownUnorderedListClass}>{children}</ul>,
  ol: ({ children }) => <ol {...markdownBlock} className={markdownOrderedListClass}>{children}</ol>,
  li: ({ children, className }) => {
    if (className === "task-list-item") {
      return (
        <li className={markdownTaskListItemClass}>
          {children}
        </li>
      );
    }
    return <li className={markdownListItemClass}>{children}</li>;
  },
  input: ({ type, checked, ...props }) => {
    if (type === "checkbox") {
      return (
        <input
          type="checkbox"
          checked={checked}
          readOnly
          className={markdownCheckboxClass}
          {...props}
        />
      );
    }
    return <input type={type} checked={checked} {...props} />;
  },

  pre: ({ children }) => (
    <pre {...markdownBlock} className={markdownBarePreClass}>
      {children}
    </pre>
  ),
  code: ({ className, children, ...props }) => {
    const isBlock = className?.split(/\s+/).includes("markdown-code-block")
      || className?.startsWith("language-")
      || className?.startsWith("hljs");
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className={markdownInlineCodeClass}
        {...props}
      >
        {children}
      </code>
    );
  },

  a: defaultAnchor,
  strong: ({ children }) => <strong className={markdownStrongClass}>{children}</strong>,
  em: ({ children }) => <em className={markdownEmphasisClass}>{children}</em>,
  del: ({ children }) => (
    <del className={markdownDeletedClass}>{children}</del>
  ),

  img: ({ src, alt }) => <MarkdownImage src={src} alt={alt??""}/>,

  hr: () => <hr {...markdownBlock} className={markdownRuleClass} />,

  blockquote: ({ children }) => (
    <blockquote
      {...markdownBlock}
      data-markdown-blockquote="true"
      className={markdownBlockquoteClass}
    >
      {children}
    </blockquote>
  ),

  table: ({ children }) => (
    <div {...markdownBlock} className={cn(markdownTableWrapperClass, markdownTableFocusClass)}>
      <table className={markdownTableClass}>{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className={markdownTableHeaderCellClass}>
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className={markdownTableCellClass}>{children}</td>
  ),
};

export const compactComponents: Components = {
  p: ({ children }) => <p {...markdownBlock} className="mb-1 last:mb-0">{children}</p>,
  h1: ({ children }) => <h1 {...markdownBlock} className="text-sm font-semibold mb-1 mt-1.5 first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 {...markdownBlock} className="text-sm font-semibold mb-1 mt-1.5 first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 {...markdownBlock} className="text-sm font-semibold mb-0.5 mt-1 first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 {...markdownBlock} className="text-sm font-medium mb-0.5 mt-1 first:mt-0">{children}</h4>,
  h5: ({ children }) => <h5 {...markdownBlock}>{children}</h5>,
  h6: ({ children }) => <h6 {...markdownBlock}>{children}</h6>,
  ul: ({ children }) => <ul {...markdownBlock} className="mb-1 last:mb-0 ml-3 list-disc">{children}</ul>,
  ol: ({ children }) => <ol {...markdownBlock} className="mb-1 last:mb-0 ml-3 list-decimal">{children}</ol>,
  li: ({ children }) => <li className="mb-0">{children}</li>,
  pre: ({ children }) => (
    <pre {...markdownBlock} className="text-xs text-muted-foreground bg-input rounded-floor px-1.5 py-1 my-1 whitespace-pre-wrap break-words overflow-auto max-h-24 font-mono">
      {children}
    </pre>
  ),
  code: ({ className, children, ...props }) => {
    const isBlock = className?.split(/\s+/).includes("markdown-code-block")
      || className?.startsWith("language-")
      || className?.startsWith("hljs");
    if (isBlock) {
      return <code className={className} {...props}>{children}</code>;
    }
    return (
      <code className="text-xs bg-input rounded-mark px-0.5 py-0 font-mono" {...props}>
        {children}
      </code>
    );
  },
  a: defaultAnchor,
  strong: ({ children }) => <strong className="font-bold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote
      {...markdownBlock}
      data-markdown-blockquote="true"
      className="border-l-2 border-muted-foreground/30 pl-2 my-1 text-muted-foreground italic"
    >
      {children}
    </blockquote>
  ),
  hr: () => <hr {...markdownBlock} />,
  table: ({ children }) => (
    <div {...markdownBlock} className={cn("overflow-auto my-1 rounded-floor border border-border bg-card", markdownTableFocusClass)}>
      <table className="text-xs border-collapse w-full">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border px-1.5 py-0.5 text-left font-semibold bg-input text-foreground">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-1.5 py-0.5 text-foreground">{children}</td>
  ),
};

export const userBubbleComponents: Components = { ...components, a: userBubbleAnchor };
export const compactUserBubbleComponents: Components = { ...compactComponents, a: userBubbleAnchor };

const BlockquoteDepthContext = createContext(0);

function CopyableCodeBlock({
  children,
  compact,
  codeBlockLayout,
}: {
  children: React.ReactNode;
  compact: boolean;
  codeBlockLayout: "bounded" | "document";
}) {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLPreElement>(null);
  const resetTimerRef = useRef<number | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "success" | "error">("idle");

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  const copyCode = async () => {
    try {
      const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (!clipboard?.writeText) throw new Error("Clipboard API is unavailable");
      const code = contentRef.current?.textContent?.replace(/\r?\n$/, "") ?? "";
      await clipboard.writeText(code);
      setCopyState("success");
    } catch {
      setCopyState("error");
    }
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => setCopyState("idle"), 1600);
  };

  const feedback = copyState === "success"
    ? t("ui.markdown.codeCopied")
    : copyState === "error"
      ? t("ui.markdown.codeCopyFailed")
      : "";
  const copied = copyState === "success";
  const handleCopy = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    void copyCode();
  };

  const copyButton = (
    <>
      <DashboardIconCap
        label={t("ui.markdown.copyCode")}
        size="small"
        appearance="bare"
        data-slot="codeblock-copy-button"
        data-copy-state={copyState}
        className={cn("absolute right-0.5 top-0.5 z-10", copied && "text-foreground")}
        onClick={handleCopy}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {copied
          ? <Check className="h-3.5 w-3.5" aria-hidden="true" />
          : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
      </DashboardIconCap>
      <span className="sr-only" role="status" aria-live="polite">{feedback}</span>
    </>
  );

  if (codeBlockLayout === "document") {
    return (
      <div {...markdownBlock} data-slot="codeblock-copy-frame" className={markdownCodeBlockFrameClass}>
        <div
          data-markdown-code-scroll="horizontal"
          className="my-1.5 overflow-x-auto overflow-y-hidden rounded-floor"
        >
          <pre
            ref={contentRef}
            data-slot="codeblock-copy-content"
            data-markdown-code-layout="document"
            className="m-0 text-xs text-muted-foreground bg-input rounded-floor px-2 py-2.5 pr-9 min-h-9 whitespace-pre-wrap break-words font-mono"
          >
            {children}
          </pre>
        </div>
        {copyButton}
      </div>
    );
  }

  if (compact) {
    return (
      <div {...markdownBlock} data-slot="codeblock-copy-frame" className={markdownCodeBlockFrameClass}>
        <pre ref={contentRef} data-slot="codeblock-copy-content" className="text-xs text-muted-foreground bg-input rounded-floor px-1.5 py-1 pr-9 min-h-9 my-1 whitespace-pre-wrap break-words overflow-auto max-h-24 font-mono">{children}</pre>
        {copyButton}
      </div>
    );
  }

  return (
    <div {...markdownBlock} data-slot="codeblock-copy-frame" className={markdownCodeBlockFrameClass}>
      <pre ref={contentRef} data-slot="codeblock-copy-content" className={markdownCodeBlockClass}>{children}</pre>
      {copyButton}
    </div>
  );
}

export function createCopyableCodeBlock(
  compact: boolean,
  codeBlockLayout: "bounded" | "document",
): NonNullable<Components["pre"]> {
  return ({ children }) => (
    <CopyableCodeBlock compact={compact} codeBlockLayout={codeBlockLayout}>
      {Children.map(children, (child) => {
        if (!isValidElement<{ className?: string }>(child)) return child;
        const className = [child.props.className, "markdown-code-block"].filter(Boolean).join(" ");
        return cloneElement(child, { className });
      })}
    </CopyableCodeBlock>
  );
}

function CopyableBlockquote({
  children,
  compact,
}: {
  children: React.ReactNode;
  compact: boolean;
}) {
  const { t } = useTranslation();
  const depth = useContext(BlockquoteDepthContext);
  const contentRef = useRef<HTMLQuoteElement>(null);
  const resetTimerRef = useRef<number | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "success" | "error">("idle");
  const quoteClassName = compact
    ? "border-l-2 border-muted-foreground/30 pl-2 my-1 text-muted-foreground italic"
    : markdownBlockquoteClass;
  // 복사 단추 자리(pr-9)를 둔 폭. 스트리밍 인용문도 같은 클래스를 쓴다.
  const copyQuoteClassName = compact ? `${quoteClassName} pr-9` : markdownBlockquoteCopyClass;

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  if (depth > 0) {
    return (
      <BlockquoteDepthContext.Provider value={depth + 1}>
        <blockquote data-markdown-blockquote="true" className={quoteClassName}>{children}</blockquote>
      </BlockquoteDepthContext.Provider>
    );
  }

  const copyQuote = async () => {
    try {
      const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (!clipboard?.writeText) throw new Error("Clipboard API is unavailable");
      await clipboard.writeText(contentRef.current?.innerText.trim() ?? "");
      setCopyState("success");
    } catch {
      setCopyState("error");
    }
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => setCopyState("idle"), 1600);
  };

  const feedback = copyState === "success"
    ? t("ui.markdown.quoteCopied")
    : copyState === "error"
      ? t("ui.markdown.quoteCopyFailed")
      : "";

  return (
    <BlockquoteDepthContext.Provider value={depth + 1}>
      <div {...markdownBlock} className={markdownBlockquoteFrameClass}>
        <blockquote
          ref={contentRef}
          data-slot="blockquote-copy-content"
          data-markdown-blockquote="true"
          className={copyQuoteClassName}
        >
          {children}
        </blockquote>
        <button
          type="button"
          aria-label={t("ui.markdown.copyQuote")}
          data-copy-state={copyState}
          onClick={() => void copyQuote()}
          className="absolute right-1 top-1 inline-flex size-7 items-center justify-center rounded-full text-muted-foreground/75 transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {copyState === "success"
            ? <Check className="size-4" aria-hidden="true" />
            : <Copy className="size-4" aria-hidden="true" />}
        </button>
        <span className="sr-only" role="status" aria-live="polite">{feedback}</span>
      </div>
    </BlockquoteDepthContext.Provider>
  );
}

export function createCopyableBlockquote(compact: boolean): NonNullable<Components["blockquote"]> {
  return ({ children }) => <CopyableBlockquote compact={compact}>{children}</CopyableBlockquote>;
}
