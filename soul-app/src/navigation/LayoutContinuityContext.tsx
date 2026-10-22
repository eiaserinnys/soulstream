import React, { createContext, useContext, useMemo, useRef } from 'react';
import type { InitialState } from '@react-navigation/native';
import type { NormalizedNavigationLocation } from './layoutNavigationState';

export type ScrollPosition = { offsetY: number; followBottom?: boolean };

export type LayoutContinuity = {
  getScrollPosition(key: string): ScrollPosition | undefined;
  setScrollPosition(key: string, value: ScrollPosition): void;
  readScroll(key: string): ScrollPosition | undefined;
  writeScroll(key: string, value: ScrollPosition): void;
  getMemoryDraft(generation: string | number, role: string, target: string): string | undefined;
  setMemoryDraft(generation: string | number, role: string, target: string, value: string): void;
  clearMemoryDraftIfMatches(generation: string | number, role: string, target: string, expected: string): void;
  getComposerReplyTarget<T>(key: string): T | undefined;
  setComposerReplyTarget<T>(key: string, value: T | null): void;
  getViewState<T>(key: string): T | undefined;
  setViewState<T>(key: string, value: T): void;
  getPhoneStateSnapshot(): InitialState | null;
  setPhoneStateSnapshot(state: InitialState | null): void;
  getTabletStateSnapshot(): InitialState | null;
  setTabletStateSnapshot(state: InitialState | null): void;
  getLastLocation(): NormalizedNavigationLocation | null;
  setLastLocation(location: NormalizedNavigationLocation | null): void;
};

const LayoutContinuityContext = createContext<LayoutContinuity | null>(null);

function memoryDraftKey(generation: string | number, role: string, target: string): string {
  return JSON.stringify([String(generation), role, target]);
}

export function LayoutContinuityProvider({ children }: { children: React.ReactNode }) {
  const scrollRef = useRef(new Map<string, ScrollPosition>());
  const draftRef = useRef(new Map<string, string>());
  const replyTargetRef = useRef(new Map<string, unknown>());
  const viewStateRef = useRef(new Map<string, unknown>());
  const phoneStateRef = useRef<InitialState | null>(null);
  const tabletStateRef = useRef<InitialState | null>(null);
  const lastLocationRef = useRef<NormalizedNavigationLocation | null>(null);

  const value = useMemo<LayoutContinuity>(() => {
    const getScrollPosition = (key: string) => scrollRef.current.get(key);
    const setScrollPosition = (key: string, position: ScrollPosition) => {
      scrollRef.current.set(key, position);
    };
    return {
      getScrollPosition,
      setScrollPosition,
      readScroll: getScrollPosition,
      writeScroll: setScrollPosition,
      getMemoryDraft: (generation, role, target) => draftRef.current.get(memoryDraftKey(generation, role, target)),
      setMemoryDraft: (generation, role, target, draft) => {
        draftRef.current.set(memoryDraftKey(generation, role, target), draft);
      },
      clearMemoryDraftIfMatches: (generation, role, target, expected) => {
        const key = memoryDraftKey(generation, role, target);
        if (draftRef.current.get(key) === expected) draftRef.current.delete(key);
      },
      getComposerReplyTarget: <T,>(key: string) => replyTargetRef.current.get(key) as T | undefined,
      setComposerReplyTarget: <T,>(key: string, replyTarget: T | null) => {
        if (replyTarget === null) replyTargetRef.current.delete(key);
        else replyTargetRef.current.set(key, replyTarget);
      },
      getViewState: <T,>(key: string) => viewStateRef.current.get(key) as T | undefined,
      setViewState: <T,>(key: string, state: T) => {
        viewStateRef.current.set(key, state);
      },
      getPhoneStateSnapshot: () => phoneStateRef.current,
      setPhoneStateSnapshot: state => {
        phoneStateRef.current = state;
      },
      getTabletStateSnapshot: () => tabletStateRef.current,
      setTabletStateSnapshot: state => {
        tabletStateRef.current = state;
      },
      getLastLocation: () => lastLocationRef.current,
      setLastLocation: location => {
        lastLocationRef.current = location;
      },
    };
  }, []);

  return <LayoutContinuityContext.Provider value={value}>{children}</LayoutContinuityContext.Provider>;
}

export function useLayoutContinuity(): LayoutContinuity {
  const continuity = useContext(LayoutContinuityContext);
  if (!continuity) throw new Error('useLayoutContinuity must be used within LayoutContinuityProvider');
  return continuity;
}

export function useOptionalLayoutContinuity(): LayoutContinuity | null {
  return useContext(LayoutContinuityContext);
}
