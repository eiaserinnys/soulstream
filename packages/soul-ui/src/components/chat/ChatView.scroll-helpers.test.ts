/**
 * ChatView 스크롤 헬퍼 단위 테스트.
 *
 * Phase 1 카드의 4개 검증 케이스를 순수 함수 레벨에서 커버한다:
 *  - 테스트 1: 초기 하단 이동 트리거 (세션 선택 → history 로드 완료)
 *  - 테스트 2: 세션당 1회 (동일 sessionKey 재호출 방지)
 *  - 테스트 3: prepend anchor delta 양수 반환
 *  - 테스트 4: snapshot null일 때 no-op (follow 모드와 무관)
 *
 * effect 래핑 자체는 수동 검증에서 확인.
 */

import { describe, it, expect } from "vitest";
import {
  shouldRunInitialBottomScroll,
  computePrependAnchorDelta,
} from "./ChatView.scroll-helpers";

describe("shouldRunInitialBottomScroll", () => {
  it("테스트 1: 세션 선택 후 히스토리 50개 로드 완료 시점에 true", () => {
    expect(
      shouldRunInitialBottomScroll({
        sessionKey: "sess-A",
        groupedLength: 50,
        historyLoading: false,
        lastScrolledSessionKey: null,
      }),
    ).toBe(true);
  });

  it("테스트 2: 동일 sessionKey에서 이미 한 번 스크롤했으면 false", () => {
    expect(
      shouldRunInitialBottomScroll({
        sessionKey: "sess-A",
        groupedLength: 60, // 새 라이브 메시지가 추가되어 length가 늘었어도
        historyLoading: false,
        lastScrolledSessionKey: "sess-A", // 같은 세션이면 재실행 금지
      }),
    ).toBe(false);
  });

  it("grouped가 비어 있으면 false (아직 히스토리 fetch 전)", () => {
    expect(
      shouldRunInitialBottomScroll({
        sessionKey: "sess-A",
        groupedLength: 0,
        historyLoading: false,
        lastScrolledSessionKey: null,
      }),
    ).toBe(false);
  });

  it("history.loading이 true이면 false (페이지 로드 대기)", () => {
    expect(
      shouldRunInitialBottomScroll({
        sessionKey: "sess-A",
        groupedLength: 50,
        historyLoading: true,
        lastScrolledSessionKey: null,
      }),
    ).toBe(false);
  });

  it("sessionKey가 null이면 false", () => {
    expect(
      shouldRunInitialBottomScroll({
        sessionKey: null,
        groupedLength: 50,
        historyLoading: false,
        lastScrolledSessionKey: null,
      }),
    ).toBe(false);
  });

  it("세션 전환: 이전 세션에서 스크롤했어도 새 세션에선 true", () => {
    expect(
      shouldRunInitialBottomScroll({
        sessionKey: "sess-B",
        groupedLength: 30,
        historyLoading: false,
        lastScrolledSessionKey: "sess-A",
      }),
    ).toBe(true);
  });

  it("에지 케이스: 이벤트 50개 미만 짧은 세션도 grouped.length > 0이면 true", () => {
    expect(
      shouldRunInitialBottomScroll({
        sessionKey: "sess-A",
        groupedLength: 3,
        historyLoading: false,
        lastScrolledSessionKey: null,
      }),
    ).toBe(true);
  });
});

describe("computePrependAnchorDelta", () => {
  it("테스트 3: messages.length 50 → 100, scrollHeight 2000 → 4000이면 delta=2000", () => {
    expect(
      computePrependAnchorDelta({
        snapshot: { scrollHeight: 2000, messagesLength: 50 },
        currentScrollHeight: 4000,
        currentMessagesLength: 100,
      }),
    ).toBe(2000);
  });

  it("테스트 4: snapshot이 null이면 null (prepend 요청이 없었음 → no-op)", () => {
    expect(
      computePrependAnchorDelta({
        snapshot: null,
        currentScrollHeight: 4000,
        currentMessagesLength: 100,
      }),
    ).toBeNull();
  });

  it("messages.length가 동일하면 null (prepend가 반영되지 않은 상태)", () => {
    // follow 모드 중 새 라이브 메시지 도착 전·후 상태: requestOlder가 안 불렸으므로
    // 현실에선 snapshot이 null이어야 정상이지만, 설령 이전 snapshot이 남아 있더라도
    // messages.length가 동일/감소면 보정하지 않는다.
    expect(
      computePrependAnchorDelta({
        snapshot: { scrollHeight: 2000, messagesLength: 100 },
        currentScrollHeight: 2100,
        currentMessagesLength: 100,
      }),
    ).toBeNull();
  });

  it("snapshot이 남아있고 messages가 증가하고 delta>0이면 반환 (snapshot 정확성은 호출부 책임)", () => {
    // 헬퍼는 "snapshot이 있고 messages가 증가했고 delta가 양수면 반환"만 한다.
    // snapshot의 정확성은 호출부(onScroll에서 requestOlder 직전에만 세팅)가 책임진다.
    // 따라서 현실에선 prepend가 아닌 라이브 증가 상황에서 snapshot이 남아있으면 안 되지만,
    // 헬퍼 레벨에서는 양수 delta를 반환한다.
    expect(
      computePrependAnchorDelta({
        snapshot: { scrollHeight: 2000, messagesLength: 100 },
        currentScrollHeight: 2100,
        currentMessagesLength: 101,
      }),
    ).toBe(100);
  });

  it("delta가 0 이하이면 null (비정상 상태 방어)", () => {
    expect(
      computePrependAnchorDelta({
        snapshot: { scrollHeight: 4000, messagesLength: 50 },
        currentScrollHeight: 3900, // 오히려 줄었다
        currentMessagesLength: 100,
      }),
    ).toBeNull();

    expect(
      computePrependAnchorDelta({
        snapshot: { scrollHeight: 4000, messagesLength: 50 },
        currentScrollHeight: 4000, // 변화 없음
        currentMessagesLength: 100,
      }),
    ).toBeNull();
  });
});
