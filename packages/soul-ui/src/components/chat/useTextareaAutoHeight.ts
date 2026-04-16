/**
 * useTextareaAutoHeight — textarea의 높이를 내용에 맞춰 자동 조절한다.
 *
 * 모바일(< 640px): h-9(36px), 데스크탑: h-8(32px)가 최소 높이이며,
 * 최대 120px까지 자동으로 늘린다.
 *
 * ChatInput 외에도 재사용 가능하도록 독립 훅으로 분리.
 */

import { useEffect, type RefObject } from "react";

export function useTextareaAutoHeight(
  ref: RefObject<HTMLTextAreaElement | null>,
  text: string,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const minH = window.innerWidth < 640 ? 36 : 32;
    el.style.height = "auto";
    el.style.height = `${Math.max(minH, Math.min(el.scrollHeight, 120))}px`;
  }, [ref, text]);
}
