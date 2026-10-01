import { ApiHttpError } from '../api/clientCore';

export function plannerCompletionErrorText(cause: unknown): string {
  if (cause instanceof ApiHttpError) {
    if (cause.status === 401) {
      return '로그인은 유지했습니다. 서버가 완료 처리 사용자를 확인하지 못했습니다.';
    }
    if (cause.status === 403) return '이 카드를 완료할 권한이 없습니다.';
    if (cause.status === 422) {
      return '서버가 이 카드의 완료 경로를 확인하지 못했습니다.';
    }
  }
  return cause instanceof Error && cause.message ? cause.message : String(cause);
}
