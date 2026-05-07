/**
 * caller-avatar-helpers 단위 테스트 (vitest node 환경, 컴포넌트 의존성 없음).
 *
 * extractInitial, formatUserId, getCallerSourceConfig 순수 함수 검증.
 */

import { describe, it, expect } from "vitest";
import {
  CALLER_SOURCE_CONFIG,
  extractInitial,
  formatUserId,
  getCallerSourceConfig,
} from "./caller-avatar-helpers";

describe("extractInitial", () => {
  it("한글 1자 반환", () => {
    expect(extractInitial("서소영")).toBe("서");
    expect(extractInitial("김주복")).toBe("김");
  });

  it("영문 두 단어는 첫 글자 두 개를 대문자로", () => {
    expect(extractInitial("John Doe")).toBe("JD");
    expect(extractInitial("alice bob")).toBe("AB");
  });

  it("영문 한 단어는 첫 두 글자를 대문자로", () => {
    expect(extractInitial("Alice")).toBe("AL");
    expect(extractInitial("kim")).toBe("KI");
  });

  it("이모지·기타 문자는 첫 1자 그대로", () => {
    expect(extractInitial("🌟abc")).toBe("🌟");
    expect(extractInitial("123")).toBe("1");
  });

  it("빈/누락 값은 '?' 반환", () => {
    expect(extractInitial("")).toBe("?");
    expect(extractInitial(undefined)).toBe("?");
    expect(extractInitial(null)).toBe("?");
    expect(extractInitial("   ")).toBe("?");
  });
});

describe("formatUserId", () => {
  it("slack source는 앞 8글자로 잘림", () => {
    expect(formatUserId("U08ABCDEFG", "slack")).toBe("U08ABCDE");
  });

  it("browser/soul-app source는 email의 @ 이전만 표시", () => {
    expect(formatUserId("user@example.com", "browser")).toBe("user");
    expect(formatUserId("kim@gmail.com", "soul-app")).toBe("kim");
  });

  it("browser source라도 @ 없으면 그대로", () => {
    expect(formatUserId("just-a-username", "browser")).toBe("just-a-username");
  });

  it("agent/api/기타 source는 user_id 그대로", () => {
    expect(formatUserId("agent-x", "agent")).toBe("agent-x");
    expect(formatUserId("api-token", "api")).toBe("api-token");
    expect(formatUserId("anything", "unknown")).toBe("anything");
  });

  it("빈/누락 값은 빈 문자열", () => {
    expect(formatUserId("", "slack")).toBe("");
    expect(formatUserId(undefined, "browser")).toBe("");
    expect(formatUserId(null, "agent")).toBe("");
  });
});

describe("getCallerSourceConfig", () => {
  it("알려진 source 5종 매핑", () => {
    expect(getCallerSourceConfig("slack")).toEqual(CALLER_SOURCE_CONFIG.slack);
    expect(getCallerSourceConfig("browser")).toEqual(CALLER_SOURCE_CONFIG.browser);
    expect(getCallerSourceConfig("soul-app")).toEqual(CALLER_SOURCE_CONFIG["soul-app"]);
    expect(getCallerSourceConfig("agent")).toEqual(CALLER_SOURCE_CONFIG.agent);
    expect(getCallerSourceConfig("api")).toEqual(CALLER_SOURCE_CONFIG.api);
  });

  it("알 수 없는 source는 fallback config", () => {
    const fallback = getCallerSourceConfig("unknown");
    expect(fallback.badge).toBe("🔹");
    expect(fallback.fallbackIcon).toBe("❔");
  });

  it("non-string source도 fallback", () => {
    expect(getCallerSourceConfig(undefined)).toEqual(getCallerSourceConfig("zzz-not-mapped"));
    expect(getCallerSourceConfig(null)).toEqual(getCallerSourceConfig("zzz-not-mapped"));
    expect(getCallerSourceConfig(123)).toEqual(getCallerSourceConfig("zzz-not-mapped"));
  });
});
