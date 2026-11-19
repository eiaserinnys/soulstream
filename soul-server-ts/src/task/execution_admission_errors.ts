/**
 * 실행 접수 경합.
 *
 * 새 실행을 세우려는 순간 같은 세션에 다른 실행이나 활성이 아직 남아 있어
 * 시동을 거절한다. 이 오류가 나는 시점에는 메시지가 이미 노드 큐에 들어가
 * 있다. 호출자에게 실패를 돌려주면 같은 지시를 다시 보내 중복 턴이 생기므로,
 * 라우트는 이 오류를 「이미 전달됨 또는 대기열에 올림」으로 바꿔 돌려준다
 * (카드 #1745, 11-18 df395b37 사례).
 */
export class ExecutionAdmissionInFlightError extends Error {
  constructor(agentSessionId: string) {
    super(`Task ${agentSessionId} already has an execution admission in flight`);
    this.name = "ExecutionAdmissionInFlightError";
  }
}
