/**
 * useTextareaAutoHeight — textarea의 높이를 내용에 맞춰 자동 조절한다.
 *
 * 최소·최대 높이는 편집 표면의 CSS가 소유한다. 내용과 폭, 글자 설정이
 * 바뀌면 같은 계약으로 높이를 맞추고 한도 이후 내부 스크롤을 사용한다.
 *
 * ChatInput 외에도 재사용 가능하도록 독립 훅으로 분리.
 */

import { useLayoutEffect, type RefObject } from "react";

export function useTextareaAutoHeight(
  ref: RefObject<HTMLTextAreaElement | null>,
  text: string,
  fontSize: number,
  active = true,
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const fit = () => {
      el.style.height = "auto";
      const style = getComputedStyle(el);
      const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
      const min = parseFloat(style.minHeight) || 0;
      const max = parseFloat(style.maxHeight);
      el.style.height = `${Math.max(min, Math.min(el.scrollHeight + border, Number.isFinite(max) ? max : Infinity))}px`;
    };
    fit();
    let lastWidth = el.clientWidth;
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
      if (lastWidth === el.clientWidth) return;
      lastWidth = el.clientWidth;
      fit();
    }) : null;
    observer?.observe(el);
    window.addEventListener("resize", fit);
    return () => { observer?.disconnect(); window.removeEventListener("resize", fit); };
  }, [ref, text, fontSize, active]);
}
