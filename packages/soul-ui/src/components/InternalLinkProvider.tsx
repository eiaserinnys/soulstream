import { createContext, useCallback, useContext, type MouseEvent, type MouseEventHandler, type ReactNode } from "react";
import { classifyInternalLink, type InternalLinkTarget } from "../lib/internal-link";

export type InternalLinkOpenTarget = (
  target: InternalLinkTarget,
  href: string,
  label?: string,
) => void | boolean | Promise<void | boolean>;

interface InternalLinkContextValue {
  internalOrigins: readonly string[];
  openTarget: InternalLinkOpenTarget;
}

const InternalLinkContext = createContext<InternalLinkContextValue | null>(null);

export function InternalLinkProvider({
  internalOrigins,
  openTarget,
  children,
}: {
  internalOrigins: readonly string[];
  openTarget: InternalLinkOpenTarget;
  children: ReactNode;
}) {
  return (
    <InternalLinkContext.Provider value={{ internalOrigins, openTarget }}>
      {children}
    </InternalLinkContext.Provider>
  );
}

/**
 * 보통 왼쪽 누름인가. 수정자 키(Ctrl, ⌘, Shift, Alt)나 다른 단추가 붙으면
 * 브라우저 기본 동작에 맡긴다(새 탭, 새 창, 저장 등).
 */
export function isPlainLeftClick(event: {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return event.button === 0
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey
    && !event.altKey;
}

export function useInternalLinkClick(): MouseEventHandler<HTMLAnchorElement> {
  const context = useContext(InternalLinkContext);
  return useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (!context || event.defaultPrevented || !isPlainLeftClick(event)) return;

    const href = event.currentTarget.getAttribute("href");
    if (href === null) return;
    const target = classifyInternalLink(href, context.internalOrigins);
    if (!target || (target.kind === "attachment" && !target.isImage)) return;

    event.preventDefault();
    event.stopPropagation();
    const label = event.currentTarget.textContent?.trim();
    if (label) void context.openTarget(target, href, label);
    else void context.openTarget(target, href);
  }, [context]);
}
