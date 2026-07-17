import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  History,
  Info,
  LayoutGrid,
  ListChecks,
  type LucideIcon,
} from "lucide-react";

import "./v3-task-section-navigation.css";

export type TaskSectionId = "information" | "checklist" | "board" | "sessions";

export type TaskSectionRefs = Record<TaskSectionId, RefObject<HTMLElement | null>>;

export interface TaskSectionFocusRequest {
  requestId: number;
  sectionId: TaskSectionId;
  sessionId?: string;
}

const TASK_SECTIONS: readonly {
  id: TaskSectionId;
  label: string;
  accessibleLabel: string;
  Icon: LucideIcon;
}[] = [
  { id: "information", label: "정보", accessibleLabel: "정보", Icon: Info },
  { id: "checklist", label: "체크", accessibleLabel: "체크리스트", Icon: ListChecks },
  { id: "board", label: "보드", accessibleLabel: "보드", Icon: LayoutGrid },
  { id: "sessions", label: "세션", accessibleLabel: "세션", Icon: History },
];

export function TaskSectionNavigation({
  scrollRef,
  sectionRefs,
  focusRequest,
  focusTargetReady = true,
  onFocusRequestHandled,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  sectionRefs: TaskSectionRefs;
  focusRequest?: TaskSectionFocusRequest | null;
  focusTargetReady?: boolean;
  onFocusRequestHandled?(requestId: number): void;
}) {
  const requestedSectionRef = useRef<TaskSectionId | null>(null);
  const requestedSectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeSection, setActiveSection] = useState<TaskSectionId>("information");

  const moveToSection = useCallback((id: TaskSectionId, target?: HTMLElement | null) => {
    const scrollElement = scrollRef.current;
    const section = sectionRefs[id].current;
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
      let nextSection = TASK_SECTIONS[0].id;
      for (const { id } of TASK_SECTIONS) {
        const section = sectionRefs[id].current;
        if (!section || section.getBoundingClientRect().top > activationLine) break;
        nextSection = id;
      }
      if (
        scrollElement.scrollTop + scrollElement.clientHeight
        >= scrollElement.scrollHeight - 2
      ) {
        nextSection = TASK_SECTIONS.at(-1)?.id ?? nextSection;
      }
      setActiveSection((current) => current === nextSection ? current : nextSection);
    };

    scrollElement.addEventListener("scroll", updateActiveSection, { passive: true });
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updateActiveSection);
    resizeObserver?.observe(scrollElement);
    for (const { id } of TASK_SECTIONS) {
      const section = sectionRefs[id].current;
      if (section) resizeObserver?.observe(section);
    }
    updateActiveSection();
    return () => {
      scrollElement.removeEventListener("scroll", updateActiveSection);
      resizeObserver?.disconnect();
      if (requestedSectionTimerRef.current) clearTimeout(requestedSectionTimerRef.current);
    };
  }, [scrollRef, sectionRefs]);

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
      aria-label="업무 섹션"
    >
      {TASK_SECTIONS.map(({ id, label, accessibleLabel, Icon }) => (
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
