/** 서버가 잇기 전이에 답한 결과다. 사유는 서버가 실어 보냈을 때만 있다. */
export interface RunnerAdoptionApplication {
  applied: boolean;
  rejectionReason?: string;
  /**
   * 거절된 것이 이 러너가 아닌 다른(낡은) 등록의 전이였다. 같은 러너로 다시 잇는다고 풀리지 않는
   * 거절이라, 러너 복구는 이 거절 뒤 간격마다 잇기를 되풀이하지 않는다.
   */
  staleRegistration?: boolean;
}

/**
 * 서버가 잇기 전이를 받아들이지 않았다는 응답이다.
 *
 * 사유가 없으면 사유를 싣지 않는다. 사유가 없는 거절은 다시 될 수 있는
 * 거절로 다룬다. 거절은 응답이지 전송 실패가 아니므로, 이 오류를 받은
 * 호출자는 같은 전이를 다시 보내지 않고 중앙 확인 판정을 다시 한다.
 */
export class RunnerAdoptionRejectedError extends Error {
  constructor(
    readonly sessionId: string,
    readonly rejectionReason: string | undefined,
    options?: ErrorOptions,
  ) {
    super(`runner adoption running transition rejected for ${sessionId}`, options);
    this.name = "RunnerAdoptionRejectedError";
  }

  /** 서버가 사유를 실어 보냈으면 그 값, 없으면 null이다. */
  get reason(): string | null {
    return this.rejectionReason ?? null;
  }
}
