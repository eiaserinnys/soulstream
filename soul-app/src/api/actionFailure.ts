/** 사용자가 누른 동작(멈춤, 도구 승인·거절)이 실패했을 때 보여줄 일상어 문구. */

export type ActionFailureKind = 'interrupt' | 'tool-approval';

export interface ActionFailure {
  /** HTTP 상태. 네트워크 예외나 시간 초과처럼 응답이 없으면 undefined. */
  status?: number;
  /** 실패 응답 본문(JSON 문자열 등). error.code 판별에만 쓴다. */
  body?: string;
}

export const INTERRUPT_FAILURE_MESSAGES = {
  notRunning: '멈출 작업이 없습니다. 이미 끝난 세션일 수 있습니다.',
  sessionMissing: '세션을 찾지 못해 멈추지 못했습니다.',
  unreachable: '노드에 연결하지 못해 멈추지 못했습니다. 다시 눌러 주세요.',
  unauthorized: '로그인이 만료되어 멈추지 못했습니다.',
  other: '멈추지 못했습니다. 다시 눌러 주세요.',
} as const;

/** 도구 승인과 입력 요청이 함께 쓰는 「이미 끝난 요청」 문구. */
export const ALREADY_RESOLVED_MESSAGE = '이미 끝난 요청이라 보내지 못했습니다.';

export const TOOL_APPROVAL_FAILURE_MESSAGES = {
  unreachable: '연결하지 못해 보내지 못했습니다. 다시 눌러 주세요.',
  alreadyResolved: ALREADY_RESOLVED_MESSAGE,
  other: '보내지 못했습니다. 다시 눌러 주세요.',
} as const;

/** 입력 요청이 이미 응답됐거나 만료됐거나 더 이상 대기 중이 아님을 알리는 서버 코드. */
export const INPUT_RESPONSE_ALREADY_HANDLED_CODES = [
  'INPUT_REQUEST_ALREADY_RESPONDED',
  'REQUEST_NOT_PENDING',
  'INPUT_REQUEST_EXPIRED',
] as const;

/** 실패 응답 본문에서 서버 오류 코드를 꺼낸다. 형식이 다르면 null. */
function actionFailureCode(body?: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    const code = parsed?.error?.code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

/**
 * 입력 요청 응답이 422와 「이미 처리됨」 코드로 돌아왔는지 판정한다.
 * 그 밖의 422 코드(INPUT_RESPONSE_NOT_SUPPORTED 등)와 다른 상태는 실패다.
 */
export function isInputResponseAlreadyHandled(
  failure: ActionFailure = {},
): boolean {
  if (failure.status !== 422) return false;
  const code = actionFailureCode(failure.body);
  return code !== null && (
    INPUT_RESPONSE_ALREADY_HANDLED_CODES as readonly string[]
  ).includes(code);
}

export function actionFailureMessage(
  kind: ActionFailureKind,
  failure: ActionFailure = {},
): string {
  const { status } = failure;
  const code = actionFailureCode(failure.body);
  const unreachable = status === undefined || status === 503 || status === 504;

  if (kind === 'interrupt') {
    if (status === 401) return INTERRUPT_FAILURE_MESSAGES.unauthorized;
    if (status === 404 || code === 'SESSION_OWNER_MISSING') {
      return INTERRUPT_FAILURE_MESSAGES.sessionMissing;
    }
    if (status === 409 || code === 'SESSION_NOT_RUNNING') {
      return INTERRUPT_FAILURE_MESSAGES.notRunning;
    }
    if (unreachable) return INTERRUPT_FAILURE_MESSAGES.unreachable;
    return INTERRUPT_FAILURE_MESSAGES.other;
  }

  if (status === 404 || status === 409
    || code === 'SESSION_OWNER_MISSING' || code === 'SESSION_NOT_RUNNING'
    || code === 'APPROVAL_NOT_FOUND' || code === 'APPROVAL_ALREADY_RESOLVED'
    || code === 'TOOL_APPROVAL_NOT_FOUND') {
    return TOOL_APPROVAL_FAILURE_MESSAGES.alreadyResolved;
  }
  if (unreachable) return TOOL_APPROVAL_FAILURE_MESSAGES.unreachable;
  return TOOL_APPROVAL_FAILURE_MESSAGES.other;
}
