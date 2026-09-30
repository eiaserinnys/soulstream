import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  History,
  Info,
  LayoutGrid,
  ListChecks,
  type LucideIcon,
} from "lucide-react";

import "./v3-folder-section-navigation.css";

export type FolderSectionId = "information" | "checklist" | "board" | "sessions";

export type FolderSectionRefs = Record<FolderSectionId, RefObject<HTMLElement | null>>;

export interface FolderSectionFocusRequest {
  requestId: number;
  sectionId: FolderSectionId;
  sessionId?: string;
}

const TASK_SECTIONS: readonly {
  id: FolderSectionId;
  label: string;
  accessibleLabel: string;
  Icon: LucideIcon;
}[] = [
  { id: "information", label: "정보", accessibleLabel: "정보", Icon: Info },
  { id: "checklist", label: "카드", accessibleLabel: "카드", Icon: ListChecks },
  { id: "board", label: "보드", accessibleLabel: "보드", Icon: LayoutGrid },
  { id: "sessions", label: "세션", accessibleLabel: "세션", Icon: History },
];

export function FolderSectionNavigation(props: {
  scrollRef: RefObject<HTMLDivElement | null>; sectionRefs: FolderSectionRefs; checklistEnabled?: boolean;
  focusRequest?: FolderSectionFocusRequest | null; focusTargetReady?: boolean;
  onFocusRequestHandled?(requestId: number): void;
}) {
  const sections = useMemo(() => TASK_SECTIONS.filter(s => s.id !== "checklist" || props.checklistEnabled !== false), [props.checklistEnabled]);
  return <SectionNavigation {...props} sections={sections} ariaLabel="업무 섹션" />;
}
export function SectionNavigation<Id extends string>({scrollRef, sectionRefs, sections, focusRequest, focusTargetReady = true, onFocusRequestHandled, ariaLabel}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  sectionRefs: Record<Id, RefObject<HTMLElement | null>>;
  sections: readonly {id:Id;label:string;accessibleLabel:string;Icon:LucideIcon}[];
  focusRequest?: {requestId:number;sectionId:Id;sessionId?:string}|null;
  focusTargetReady?: boolean; onFocusRequestHandled?(requestId:number):void; ariaLabel:string;
}) {
  const requestedSectionRef = useRef<Id | null>(null);
  const requestedSectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeSection, setActiveSection] = useState<Id>(sections[0].id);

  const moveToSection = useCallback((id: Id, target?: HTMLElement | null) => {
    const scrollElement = scrollRef.current;
    const section = sectionRefs[id]?.current;
    const targetElement = target ?? section;
    if (!scrollElement || !section || !targetElement) return;
    const top = targetElement.getBoundingClientRect().top
      - scrollElement.getBoundingClientRect().top
      + scrollElement.scrollTop
      - 12;
    const reduceMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    requestedSectionRef.current = id;
    if (requestedSectionTimerRef.current) clearTimeout(requestedSectionTimerRef.current);
    requestedSectionTimerRef.current = setTimeout(() => {
      requestedSectionRef.current = null;
      requestedSectionTimerRef.current = null;
    }, 600);
    setActiveSection(id);
    scrollElement.scrollTo({
      top: Math.max(0, top),
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }, [scrollRef, sectionRefs]);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;

    const updateActiveSection = () => {
      if (requestedSectionRef.current) {
        const requestedSection = requestedSectionRef.current;
        setActiveSection((current) => current === requestedSection ? current : requestedSection);
        return;
      }
      const scrollRect = scrollElement.getBoundingClientRect();
      const activationLine = scrollRect.top + Math.min(
        96,
        Math.max(56, scrollElement.clientHeight * 0.18),
      );
      let nextSection = sections[0].id;
      for (const { id } of sections) {
        const section = sectionRefs[id]?.current;
        if (!section || section.getBoundingClientRect().top > activationLine) break;
        nextSection = id;
      }
      if (
        scrollElement.scrollTop + scrollElement.clientHeight
        >= scrollElement.scrollHeight - 2
      ) {
        nextSection = sections.at(-1)?.id ?? nextSection;
      }
      setActiveSection((current) => current === nextSection ? current : nextSection);
    };

    scrollElement.addEventListener("scroll", updateActiveSection, { passive: true });
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updateActiveSection);
    resizeObserver?.observe(scrollElement);
    for (const { id } of sections) {
      const section = sectionRefs[id]?.current;
      if (section) resizeObserver?.observe(section);
    }
    updateActiveSection();
    return () => {
      scrollElement.removeEventListener("scroll", updateActiveSection);
      resizeObserver?.disconnect();
      if (requestedSectionTimerRef.current) clearTimeout(requestedSectionTimerRef.current);
    };
  }, [sections, scrollRef, sectionRefs]);

  useEffect(() => {
    if (!focusRequest || !focusTargetReady) return;
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;
    const target = focusRequest.sessionId
      ? Array.from(scrollElement.querySelectorAll<HTMLElement>("[data-session-id]"))
        .find((element) => element.dataset.sessionId === focusRequest.sessionId)
      : null;
    if (focusRequest.sessionId && !target) return;
    moveToSection(focusRequest.sectionId, target);
    onFocusRequestHandled?.(focusRequest.requestId);
  }, [focusRequest, focusTargetReady, moveToSection, onFocusRequestHandled, scrollRef]);

  return (
    <nav
      className="v3-task-section-nav"
      aria-label={ariaLabel}
    >
      {sections.map(({ id, label, accessibleLabel, Icon }) => (
        <button
          key={id}
          type="button"
          className="v3-task-section-anchor"
          aria-label={`${accessibleLabel} 섹션으로 이동`}
          aria-current={activeSection === id ? "location" : undefined}
          onClick={() => moveToSection(id)}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
