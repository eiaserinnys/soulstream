/**
 * ChatView - SSE 이벤트를 시간순 채팅 로그로 표시
 *
 * 트리를 flat 메시지 리스트로 변환하여 DM 스타일 채팅 UI로 렌더링한다.
 * 하단에 ChatInput을 배치하여 인터벤션/리줌 메시지를 전송한다.
 *
 * Phase 4 재설계:
 * - react-virtuoso + `alignToBottom + followOutput="auto"` 로 "첫 paint가 이미 최하단" 을 달성.
 *   이동 궤적 없이 하단 고정.
 * - prepend는 virtuoso 공식 패턴 `firstItemIndex -= N` (store.chatPrependedCount 참조 — 정본은 store).
 * - 시각 상단 진입 판정은 virtuoso `startReached` 콜백으로 일원화.
 * - focusEventId 하이라이트는 `itemsRendered` 콜백에서 `scrollerRef` 범위로 한정한 querySelector로 처리.
 * - 세션 전환은 Virtuoso `key={activeSessionKey}` 재마운트로 처리.
 *
 * Follow mode: 새 메시지 도착 시 자동 스크롤 follow/unfollow 토글.
 * Tool grouping: 연속된 tool 메시지를 접기/펼치기 그룹으로 묶어 표시.
 */

import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useDashboardStore } from "../../stores/dashboard-store";
import { flattenTree } from "../../lib/flatten-tree";
import { ChatInput } from "../ChatInput";
import { cn } from "../../lib/cn";
import { useLlmContext } from "./hooks";
import { groupMessages } from "../../lib/grouping";
import { VirtualizedItem } from "./VirtualizedItem";
import { useMessageHistoryBuffer } from "./useMessageHistoryBuffer";
import { computeFirstItemIndex, findFocusIndex } from "./ChatView.reverse-helpers";
import { decideFollowOnAtBottomChange } from "./ChatView.follow-helpers";

interface ChatViewProps {
  chatInputDisabled?: boolean;
  isOtherNodeSession?: boolean;
  fileUploadUrl?: string;
}

export function ChatView({
  chatInputDisabled = false,
  isOtherNodeSession = false,
  fileUploadUrl,
}: ChatViewProps = {}) {
  const tree = useDashboardStore((s) => s.tree);
  const treeVersion = useDashboardStore((s) => s.treeVersion);
  const activeSessionKey = useDashboardStore((s) => s.activeSessionKey);
  const focusEventId = useDashboardStore((s) => s.focusEventId);
  const setFocusEventId = useDashboardStore((s) => s.setFocusEventId);
  /**
   * 채팅창 좌표 정본 — store에서 직접 select.
   *
   * processHistoryEvents가 grouped 차분만큼 atomic 갱신한다.
   * 같은 set() 안에서 tree와 함께 갱신되므로 1렌더 사이클 정합이 보장된다.
   */
  const chatPrependedCount = useDashboardStore((s) => s.chatPrependedCount);
  /**
   * 마지막 prepend 시각 — atBottom=true settle 가드용 (decideFollowOnAtBottomChange).
   * processHistoryEvents의 set() 안에서 chatPrependedCount와 함께 atomic 갱신되므로
   * 이 selector도 chatPrependedCount와 같은 렌더 사이클에 갱신된다.
   */
  const chatLastPrependAtMs = useDashboardStore((s) => s.chatLastPrependAtMs);
  const llmContext = useLlmContext();

  // 옵션 D: 히스토리는 useMessageHistoryBuffer가 store.tree에 직접 통합한다.
  // ChatView는 단일 트리(store.tree)에서 flattenTree로 메시지 리스트를 얻는다.
  // (이전 Phase 3에서는 historicalMessages/liveMessages 두 채널을 eventId로 병합했으나,
  //  옵션 D 통합 후엔 정본이 store.tree 하나로 단일화되어 병합 dedup이 폐기되었다.)
  const history = useMessageHistoryBuffer(activeSessionKey);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const messages = useMemo(() => flattenTree(tree), [tree, treeVersion]);
  const grouped = useMemo(() => groupMessages(messages), [messages]);

  // virtuoso prepend 패턴: START_INDEX - 누적 prepend 개수 (grouped 단위)
  const firstItemIndex = useMemo(
    () => computeFirstItemIndex(chatPrependedCount),
    [chatPrependedCount],
  );

  // === Follow mode ===
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  /**
   * virtuoso 내부 스크롤러 DOM 레퍼런스. `itemsRendered` 콜백에서 포커스 타겟을
   * 찾을 때 `document.querySelector` 전역 쿼리 대신 이 범위로 한정한다.
   */
  const scrollerRef = useRef<HTMLElement | null>(null);
  const [isFollowing, setIsFollowing] = useState(true);
  const [showNewMessage, setShowNewMessage] = useState(false);
  const prevTreeVersion = useRef(treeVersion);
  // ref로 effect 내부에서 최신 상태를 참조 (effect deps에서 제거하여 불필요한 재실행 방지)
  const isFollowingRef = useRef(true);
  useEffect(() => { isFollowingRef.current = isFollowing; }, [isFollowing]);
  /**
   * 같은 focusEventId에 대해 `itemsRendered`가 반복 호출되어도 하이라이트 타이머가
   * 중첩되지 않도록 1회 처리 후 여기에 기록한다. 세션 전환 시 null로 초기화.
   */
  const handledFocusRef = useRef<number | null>(null);

  /**
   * 세션 전환 시점 기록 (auto-follow 가드용).
   *
   * `key={activeSessionKey}`는 `<Virtuoso>`에만 붙어 있어 ChatView 컴포넌트
   * 자체는 재마운트되지 않는다. 따라서 useRef 초기값은 최초 마운트 1회만 유효.
   * 세션 전환 시 갱신은 render 본체에서 prev/curr 비교로 즉시 수행한다 —
   * useEffect로 미루면 Virtuoso remount 직후의 첫 atBottomStateChange(false)
   * 콜백이 effect보다 먼저 호출되어 sessionMs가 직전 세션 시각 기준이 되고
   * 가드가 무력화될 수 있다.
   *
   * decideFollowOnAtBottomChange가 이 ref 기반 sessionMs로 measure 깜빡임 윈도를
   * 판정한다.
   */
  const sessionStartedAtRef = useRef<number>(performance.now());
  const prevSessionKeyForFollowRef = useRef<string | null>(activeSessionKey);
  if (prevSessionKeyForFollowRef.current !== activeSessionKey) {
    prevSessionKeyForFollowRef.current = activeSessionKey;
    sessionStartedAtRef.current = performance.now();
  }

  // 새 이벤트 시: following이 아니면 "New Messages" 배너 표시.
  // 실제 하단 유지는 virtuoso `followOutput="auto"` 가 담당하므로 여기서는
  // 배너 상태만 제어한다. (수동 scrollToIndex 호출 제거)
  useEffect(() => {
    if (treeVersion === prevTreeVersion.current) return;
    prevTreeVersion.current = treeVersion;
    if (!isFollowingRef.current) setShowNewMessage(true);
  }, [treeVersion]);

  // 세션 변경 시: follow 리셋 + 이전 세션의 focusEventId 잔재 정리.
  // 다른 세션에 우연히 같은 eventId가 존재하면 엉뚱한 메시지를 하이라이트할 수 있으므로
  // 세션이 바뀌는 순간 focusEventId와 handledFocusRef를 모두 비운다.
  // 실제 스크롤 위치 리셋은 Virtuoso `key={activeSessionKey}` 재마운트로 처리된다.
  useEffect(() => {
    setIsFollowing(true);
    setShowNewMessage(false);
    setFocusEventId(null);
    handledFocusRef.current = null;
  }, [activeSessionKey, setFocusEventId]);

  // 검색 결과 클릭 시: focusEventId에 해당하는 메시지로 스크롤.
  // 하이라이트는 itemsRendered 콜백에서 DOM 쿼리 후 적용.
  useEffect(() => {
    if (!focusEventId || grouped.length === 0) return;
    const targetIndex = findFocusIndex(grouped, focusEventId);
    if (targetIndex < 0) return; // 다음 treeVersion tick에서 재시도
    virtuosoRef.current?.scrollToIndex({
      index: targetIndex + firstItemIndex,
      align: "center",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusEventId, treeVersion, grouped, firstItemIndex]);

  const scrollToBottom = useCallback(() => {
    if (grouped.length === 0) return;
    virtuosoRef.current?.scrollToIndex({
      index: grouped.length - 1 + firstItemIndex,
      align: "end",
      behavior: "smooth",
    });
    setIsFollowing(true);
    setShowNewMessage(false);
  }, [grouped.length, firstItemIndex]);

  const toggleFollow = useCallback(() => {
    setIsFollowing((prev) => {
      const next = !prev;
      if (next && grouped.length > 0) {
        virtuosoRef.current?.scrollToIndex({
          index: grouped.length - 1 + firstItemIndex,
          align: "end",
          behavior: "smooth",
        });
        setShowNewMessage(false);
      }
      return next;
    });
  }, [grouped.length, firstItemIndex]);

  if (!activeSessionKey) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Select a session to view chat
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {messages.length === 0 && !history.loading && (
        <div className="p-5 text-center text-muted-foreground text-sm">
          Waiting for events...
        </div>
      )}
      {/* Phase 3: 과거 페이지 로딩 / 맨 위 도달 인디케이터 */}
      {history.loading && (
        <div className="p-2 text-center text-muted-foreground text-xs">
          Loading earlier messages...
        </div>
      )}
      {history.reachedTop && messages.length > 0 && (
        <div className="py-2 px-3 text-center text-muted-foreground text-xs opacity-60">
          {"\u2014"} Beginning of conversation {"\u2014"}
        </div>
      )}

      {messages.length > 0 && (
        <Virtuoso
          key={activeSessionKey}
          ref={virtuosoRef}
          scrollerRef={(ref) => {
            scrollerRef.current = ref as HTMLElement | null;
          }}
          data={grouped}
          firstItemIndex={firstItemIndex}
          initialTopMostItemIndex={
            grouped.length > 0 ? { index: grouped.length - 1, align: "end" } : 0
          }
          alignToBottom
          // isFollowing=false (사용자가 위로 스크롤한 상태)일 때는 auto-follow 비활성화.
          // 그렇지 않으면 prepend로 데이터가 늘어날 때마다 Virtuoso가 맨 아래로 끌어내려
          // 사용자 스크롤 위치가 흔들리고(플리커) follow 버튼 후 최신 메시지 미표시 등의
          // 부작용이 발생한다. follow 버튼 클릭 시 setIsFollowing(true)으로 다시 활성화.
          followOutput={isFollowing ? "auto" : false}
          atBottomStateChange={(atBottom) => {
            // 두 가지 measure 깜빡임을 모두 가드한다:
            //   - 세션 전환 직후 atBottom=false 깜빡임 (sessionMs 기반)
            //   - prepend 직후 atBottom=true 깜빡임 (prependAgeMs 기반)
            // 헬퍼가 null을 반환하면 isFollowing 변경하지 않음.
            const sessionMs = performance.now() - sessionStartedAtRef.current;
            const prependAgeMs =
              chatLastPrependAtMs === null
                ? null
                : performance.now() - chatLastPrependAtMs;
            const next = decideFollowOnAtBottomChange(atBottom, sessionMs, prependAgeMs);
            if (next !== null) {
              setIsFollowing(next);
            }
            // showNewMessage는 atBottom=true 보고가 신뢰 가능한지와 무관하게
            // 사용자가 끝에 닿았다는 raw 신호로만 끄면 충분.
            if (atBottom) setShowNewMessage(false);
          }}
          startReached={() => {
            history.requestOlder();
          }}
          /**
           * tool-group은 messages[length-1].treeNodeId — prepend 시 가장 최신 멤버는
           * 변하지 않으므로 키가 안정적. messages[0]은 prepend로 변경되어 키 불안정.
           * grouping.ts L18-22로 tool-group은 messages.length >= 2 보장 (안전).
           */
          computeItemKey={(_index, item) =>
            item.type === "tool-group"
              ? `tg-${item.messages[item.messages.length - 1].treeNodeId}`
              : item.msg.treeNodeId
          }
          itemContent={(_, item) => (
            <VirtualizedItem
              item={item}
              llmContext={llmContext}
              sessionId={activeSessionKey ?? undefined}
            />
          )}
          itemsRendered={() => {
            if (focusEventId == null) return;
            // 이미 이 focusEventId를 처리했다면 중복 예약 방지
            if (handledFocusRef.current === focusEventId) return;
            // scrollerRef로 virtuoso 내부 스크롤러 DOM 범위 한정 (document 전역 쿼리 금지)
            const el = scrollerRef.current?.querySelector(
              `[data-tree-node-id$="-${focusEventId}"]`,
            ) as HTMLElement | null;
            if (!el) return;
            handledFocusRef.current = focusEventId;
            el.classList.add("ring-2", "ring-accent-amber", "rounded");
            window.setTimeout(() => {
              el.classList.remove("ring-2", "ring-accent-amber", "rounded");
              setFocusEventId(null);
            }, 2000);
          }}
          className="flex-1 overflow-x-hidden py-2 overscroll-none"
        />
      )}

      {/* "New Messages" banner */}
      {showNewMessage && !isFollowing && (
        <div className="relative">
          <button
            onClick={scrollToBottom}
            className="absolute bottom-[var(--panel-inset)] left-1/2 -translate-x-1/2 text-xs text-muted-foreground bg-popover/90 border border-border rounded-full px-3 py-1 hover:text-foreground hover:bg-popover transition-colors shadow-sm z-10"
          >
            {"\u2193"} New Messages
          </button>
        </div>
      )}

      {/* Follow toggle button */}
      <div className="relative">
        <button
          onClick={toggleFollow}
          className={cn(
            "absolute bottom-[15px] right-[15px] flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors",
            "border shadow-md z-10",
            isFollowing
              ? "bg-accent-blue/15 border-accent-blue/30 text-accent-blue hover:bg-accent-blue/25"
              : "bg-popover border-border text-muted-foreground hover:bg-input",
          )}
        >
          {"\u2193"} Follow
        </button>
      </div>

      {/* ChatInput */}
      <ChatInput
        additionalDisabled={chatInputDisabled}
        isOtherNodeSession={isOtherNodeSession}
        fileUploadUrl={fileUploadUrl}
      />
    </div>
  );
}
