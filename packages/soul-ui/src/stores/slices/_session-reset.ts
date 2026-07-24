/**
 * Session Reset Helper
 *
 * 세션 전환 시 초기화할 cross-slice 상태를 매번 새 인스턴스로 생성한다 (Set/객체 공유 방지).
 * 다음 3곳이 사용한다:
 *   - session-slice.setActiveSession
 *   - session-slice.clearActiveSession
 *   - optimistic-session-slice.addOptimisticSession
 *
 * 정본은 각 슬라이스의 *InitialState factory가 갖고, 본 모듈은 cross-slice 합성만 한다
 * (design-principles §3 정본 하나). 슬라이스에 새 필드가 추가되어도 본 모듈은 자동으로
 * 동기화되며, 추가/누락이 한 곳에서만 발생하지 않는다.
 *
 * NOTE: activeSessionSummary는 의도적으로 누락된다 — caller가 setActiveSessionSummary로
 *       별도 갱신하기 때문 (기존 동작 보존). 따라서 session-slice의 *전체* 초기 state가
 *       아니라 일부(activeSessionKey/activeSession/select* 5개)만 spread한다.
 *       activeRightTab은 ui-slice 소유이지만 세션 전환 시 항상 "chat"으로 리셋이
 *       의도된 동작이므로 본 helper에 포함된다.
 */

import { getEventProcessingInitialState } from "./event-processing-slice";
import { getSessionSliceInitialState } from "./session-slice";

export function getSessionResetState() {
  // session-slice 초기값에서 activeSessionSummary는 reset에 포함하지 않는다 (위 NOTE 참조).
  const { activeSessionSummary: _omit, ...sessionPartial } = getSessionSliceInitialState();
  return {
    ...sessionPartial,
    ...getEventProcessingInitialState(),
    activeRightTab: "chat" as const, // ui-slice 소유 — 세션 전환 시 항상 "chat" 리셋이 의도된 동작
    activeBoardDocumentId: null,
    pendingBoardDocumentEditId: null,
    activeCustomViewId: null,
  };
}
