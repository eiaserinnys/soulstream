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

export function useInternalLinkClick(): MouseEventHandler<HTMLAnchorElement> {
  const context = useContext(InternalLinkContext);
  return useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (
      !context
      || event.defaultPrevented
      || event.button !== 0
      || event.ctrlKey
      || event.metaKey
      || event.shiftKey
      || event.altKey
    ) return;

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
