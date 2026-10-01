import type { ApiRequestContext } from './clientCore';

export function createPushEndpoints({ base, authFetch, readJson }: ApiRequestContext) {
  return {
    // Push 토큰 등록/해제. 호출자는 반환값을 사용하지 않으므로 register는 Promise<unknown>.
    registerPushToken: (body: { token: string; deviceId: string }): Promise<unknown> =>
      authFetch(`${base}/api/push/register`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      }).then((r) => readJson(r, 'registerPushToken')),

    deregisterPushToken: (deviceId: string): Promise<Response> =>
      authFetch(`${base}/api/push/register/${encodeURIComponent(deviceId)}`, {
        method: 'DELETE',
      }),
  };
}
