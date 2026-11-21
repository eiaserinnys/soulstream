import { isRecord } from '../../../packages/wire-schema/src/json_record';

export type ReviewAcknowledgeResult =
  | {
      kind: 'acknowledged' | 'already_acknowledged';
      status: 'ok';
      agentSessionId: string;
      reviewState: 'acknowledged';
      changed: boolean;
    }
  | {
      kind: 'server_error';
      status: number;
      code: string;
      message: string;
    };

export async function parseReviewAcknowledgeResponse(
  response: Response,
): Promise<ReviewAcknowledgeResult> {
  const payload = await response.json().catch(() => undefined) as unknown;
  if (response.ok) {
    if (isSuccessPayload(payload)) {
      return {
        kind: payload.changed ? 'acknowledged' : 'already_acknowledged',
        ...payload,
      };
    }
    return {
      kind: 'server_error',
      status: response.status,
      code: 'INVALID_REVIEW_ACKNOWLEDGE_RESPONSE',
      message: '서버의 검수 확인 응답 형식이 올바르지 않습니다.',
    };
  }

  const error = isRecord(payload) && isRecord(payload.error)
    ? payload.error
    : undefined;
  return {
    kind: 'server_error',
    status: response.status,
    code:
      typeof error?.code === 'string'
        ? error.code
        : 'REVIEW_ACKNOWLEDGE_FAILED',
    message:
      typeof error?.message === 'string'
        ? error.message
        : `검수 확인에 실패했습니다 (${response.status}).`,
  };
}

function isSuccessPayload(value: unknown): value is {
  status: 'ok';
  agentSessionId: string;
  reviewState: 'acknowledged';
  changed: boolean;
} {
  return (
    isRecord(value) &&
    value.status === 'ok' &&
    typeof value.agentSessionId === 'string' &&
    value.reviewState === 'acknowledged' &&
    typeof value.changed === 'boolean'
  );
}
