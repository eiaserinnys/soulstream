/** 노드 ack의 code 칸에 실리는 영구 resume 거절 코드. 중앙이 같은 문자열로 알아본다. */
export const RESUME_REJECTED_CODE = "RESUME_REJECTED";

/**
 * 이 세션은 다시 보내도 이어 쓸 수 없다. 이벤트를 쓰기 전에 던지며, 문구는 사용자에게 그대로 간다.
 * 노드 기동 중 등록부가 덜 찬 것 같은 일시 오류에는 쓰지 않는다.
 */
export class ResumeRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeRejectedError";
  }
}
