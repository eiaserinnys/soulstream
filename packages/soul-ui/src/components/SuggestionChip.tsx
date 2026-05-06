/**
 * SuggestionChip
 *
 * Claude SDK가 turn 직후 emit하는 prompt_suggestion을 채팅 입력창 위에 표시하는 단일 chip.
 *
 * 인터랙션:
 *   - 짧은 탭         → onShortTap(text): 보통 입력창에 텍스트를 채운다.
 *   - 1초 롱프레스    → onSendImmediate(text): 즉시 전송. 햅틱(navigator.vibrate(30))도 발화.
 *
 * 진행률 게이지: 누르고 있는 동안 하단에 0~100% 너비의 막대가 채워진다.
 * onSendImmediate가 미제공이면 long-press가 비활성화되어 chip은 "탭 전용"으로 동작한다.
 *
 * click 이벤트 가드: 롱프레스가 발화한 직후 release 시 button click이 합성되어
 * onShortTap이 잘못 호출되는 것을 longPressFiredRef로 차단한다.
 */

import { useState, useRef } from "react";
import { useLongPress } from "../hooks/useLongPress";

interface SuggestionChipProps {
  text: string;
  onShortTap: (text: string) => void;
  onSendImmediate?: (text: string) => Promise<void> | void;
}

export function SuggestionChip({
  text,
  onShortTap,
  onSendImmediate,
}: SuggestionChipProps) {
  const [progress, setProgress] = useState(0);
  const longPressFiredRef = useRef(false);

  const handleLongPress = () => {
    longPressFiredRef.current = true;
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      try {
        navigator.vibrate?.(30);
      } catch {
        // 일부 브라우저는 user-gesture 외 호출 시 throw할 수 있음 — 무시
      }
    }
    void onSendImmediate?.(text);
  };

  const longPressHandlers = useLongPress(handleLongPress, {
    delay: 1000,
    onProgress: setProgress,
    disabled: !onSendImmediate,
  });

  const handleClick = () => {
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return;
    }
    onShortTap(text);
  };

  return (
    <button
      type="button"
      data-testid="suggestion-chip"
      className="relative w-full text-left items-start whitespace-normal break-words rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground hover:bg-muted/70 transition-colors overflow-hidden mb-2"
      onClick={handleClick}
      {...longPressHandlers}
    >
      {text}
      {progress > 0 && (
        <span
          aria-hidden="true"
          className="absolute bottom-0 left-0 h-1.5 bg-primary/70 transition-[width]"
          style={{ width: `${progress}%` }}
        />
      )}
    </button>
  );
}
