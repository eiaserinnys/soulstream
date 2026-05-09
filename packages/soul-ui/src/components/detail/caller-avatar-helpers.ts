/**
 * CallerAvatar 컴포넌트의 순수 로직 (이니셜 추출, source 뱃지/fallback 결정,
 * source별 user_id 표시 분기) — vitest node 환경에서 .test.ts로 검증.
 *
 * React 컴포넌트 자체 렌더 테스트는 jsdom + @testing-library/react 인프라가
 * 본 패키지에 setup되지 않아 별도 카드로 분리. 본 모듈은 순수 함수만 노출하므로
 * 컴포넌트 의존성 없이 단위 테스트 가능.
 */

export interface CallerSourceConfig {
  /** 라벨 옆 또는 뱃지로 표시할 source 이모지 */
  badge: string;
  /** 이미지 로드 실패·display_name 누락 시 표시할 fallback 아이콘 */
  fallbackIcon: string;
}

/**
 * source 값별 표시 설정. 통합 스키마 v1의 6종 source.
 *
 * F-11 (2026-05-09): 'system' 추가 — soulstream 서버 lifecycle 인터벤션 (재시작 예고/완료
 * 안내). avatar_url=null로 보내지므로 ⚙️ fallback이 곧 시각적 식별자 역할을 한다 (web은
 * /system-portrait.png 정적 자원으로 InterventionMessage가 별도 분기, 본 config는 detail
 * 패널·뱃지용 fallback).
 */
export const CALLER_SOURCE_CONFIG: Record<string, CallerSourceConfig> = {
  slack: { badge: "💬", fallbackIcon: "💬" },
  browser: { badge: "🌐", fallbackIcon: "👤" },
  "soul-app": { badge: "📱", fallbackIcon: "👤" },
  agent: { badge: "🤖", fallbackIcon: "🤖" },
  api: { badge: "⚙️", fallbackIcon: "⚙️" },
  system: { badge: "⚙️", fallbackIcon: "⚙️" },
};

/** 알 수 없는 source는 중립 fallback config 반환. */
const UNKNOWN_CONFIG: CallerSourceConfig = { badge: "🔹", fallbackIcon: "❔" };

export function getCallerSourceConfig(source: unknown): CallerSourceConfig {
  const key = typeof source === "string" ? source : "";
  return CALLER_SOURCE_CONFIG[key] ?? UNKNOWN_CONFIG;
}

/**
 * display_name에서 이니셜 추출.
 *  - 한글(가–힣): 첫 1자
 *  - 영문: 두 단어 이상이면 두 단어 첫 글자 (예: "John Doe" → "JD"),
 *    한 단어면 첫 두 글자 (예: "Alice" → "AL")
 *  - 그 외(이모지·숫자 등): 첫 1자
 *  - 빈 값: "?"
 */
export function extractInitial(name: string | undefined | null): string {
  if (!name) return "?";
  const trimmed = name.trim();
  if (!trimmed) return "?";
  // Array.from으로 surrogate pair 안전 처리 (이모지 등 BMP 외 코드포인트 → 단일 grapheme).
  // trimmed[0]은 surrogate를 분리하여 깨진 문자가 나옴.
  const first = Array.from(trimmed)[0];
  // 한글 (가–힣 + 호환 자모)
  if (/[가-힯ㄱ-ㅎㅏ-ㅣ]/.test(first)) {
    return first;
  }
  // 영문
  if (/[A-Za-z]/.test(first)) {
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length >= 2 && /[A-Za-z]/.test(words[1][0])) {
      return (words[0][0] + words[1][0]).toUpperCase();
    }
    return trimmed.slice(0, 2).toUpperCase();
  }
  // 그 외 (이모지·숫자·기호 등) — 첫 grapheme
  return first;
}

/**
 * source별 user_id 표시 형식.
 *  - slack: 앞 8글자 (Slack U... ID는 보통 11자)
 *  - browser/soul-app: email 형식이면 @ 이전 username만 (전체 email은 별도 email 라벨로 표시)
 *  - agent/api/기타: 그대로
 *  - 빈 값: ""
 */
export function formatUserId(userId: string | undefined | null, source: unknown): string {
  if (!userId) return "";
  if (source === "slack") return userId.slice(0, 8);
  if (source === "browser" || source === "soul-app") {
    const atIndex = userId.indexOf("@");
    return atIndex > 0 ? userId.slice(0, atIndex) : userId;
  }
  return userId;
}
