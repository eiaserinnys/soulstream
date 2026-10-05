import { ApiHttpError } from '../../api/clientCore';
import { safeErrorDetail } from '../../../../packages/soul-ui/src/lib/safe-error-detail';

export interface PersistentSessionFailure {
  /** User-facing reason, already stripped of anything unsafe to show. */
  text: string;
  /** Set only for PERSISTENT_REGISTRATION_FAILED: the plain session exists, registration did not finish. */
  createdSession: { session_id: string; display_name: string | null } | null;
  /** The POST answer never arrived, so the session may exist without us knowing its id. */
  responseLost: boolean;
}

type ErrorBody = {
  error?: { code?: unknown; message?: unknown };
  created_session?: { session_id?: unknown; display_name?: unknown };
};

// The server's free-text message is never shown (error-display boundary); its fixed code picks the sentence.
const CODE_TEXT: Record<string, string> = {
  INVALID_REQUEST: '입력한 값을 저장할 수 없습니다. 이름과 기본 모델을 확인해 주세요.',
  INVALID_MODEL_PRESET: '선택한 모델을 지금 쓸 수 없습니다. 다른 모델을 골라 주세요.',
  UNSUPPORTED_REASONING_EFFORT: '선택한 모델이 지원하지 않는 설정입니다. 다른 모델을 골라 주세요.',
  SESSION_NOT_FOUND: '영구 에이전트 세션을 찾을 수 없습니다. 목록을 다시 읽어 주세요.',
  NOT_PERSISTENT: '이미 영구 세션이 아닙니다. 목록을 다시 읽어 주세요.',
  NODE_UNAVAILABLE: '세션이 있는 노드에 연결할 수 없습니다.',
  NODE_COMMAND_TIMEOUT: '노드가 제때 응답하지 않았습니다.',
  PERSISTENT_REGISTRATION_FAILED: '영구 세션으로 등록하지 못했습니다.',
};

function parseBody(text: string): ErrorBody | null {
  try { const body = JSON.parse(text); return body && typeof body === 'object' ? body as ErrorBody : null; } catch { return null; }
}

/** Reads the `{ error: { code, message } }` shape the persistent session routes answer with. */
export function describePersistentFailure(cause: unknown, op: 'load' | 'save' | 'create' | 'release'): PersistentSessionFailure {
  const http = cause instanceof ApiHttpError ? cause : null;
  const body = http ? parseBody(http.body) : null;
  const code = typeof body?.error?.code === 'string' ? body.error.code : null;
  const created = body?.created_session;
  const createdSession = code === 'PERSISTENT_REGISTRATION_FAILED' && typeof created?.session_id === 'string'
    ? { session_id: created.session_id, display_name: typeof created.display_name === 'string' ? created.display_name : null }
    : null;
  let text = (code && CODE_TEXT[code]) || safeErrorDetail(cause instanceof Error ? cause.message : String(cause));
  // Rename, settings and the model switch are saved one after another, so a server-side failure can leave part of them saved.
  if (op === 'save' && http && http.status >= 500) text += ' 일부 변경이 저장됐을 수 있습니다. 다시 읽거나 저장해 주세요.';
  return { text, createdSession, responseLost: op === 'create' && !http };
}
