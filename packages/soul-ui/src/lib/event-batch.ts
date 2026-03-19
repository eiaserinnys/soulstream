/**
 * 이벤트 배치 처리 상수
 *
 * SSE 이벤트를 개별 처리하지 않고 배치로 모아서 처리할 때 사용하는 공통 상수.
 * 히스토리 리플레이 시 set() 호출 횟수를 줄여 UI 프리징을 방지합니다.
 */

/** 배치 처리 청크 크기. 이 수만큼 이벤트를 모아서 processEvents() 1회 호출 */
export const BATCH_SIZE = 64;

/** 배치 플러시 대기 시간 (ms). 이벤트가 BATCH_SIZE에 도달하지 않아도 이 시간이 지나면 플러시 */
export const BATCH_FLUSH_MS = 16;
