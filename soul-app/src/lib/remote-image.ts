/**
 * 원격 이미지의 주소 꼴로 캐시 정책을 정하고, 같은 출처일 때만 Bearer를 붙이는 순수 도우미.
 *
 * 디스크 캐시는 "주소가 바뀌어야만 내용이 바뀌는 주소"에만 쓴다. 그 밖의 주소(v 없는 초상,
 * 시스템 초상, 구글 사진 같은 바깥 주소)가 디스크에 남아 바뀐 내용을 못 받는 일이 없게 하려는 규칙이다.
 */

export interface RemoteImageSource {
  uri: string;
  headers?: Record<string, string>;
}

export type RemoteImageCachePolicy = 'memory-disk' | 'memory';

const PARSE_BASE = 'https://remote-image.invalid';
const VERSIONED_PORTRAIT_PATH = /^\/api\/agent-portraits\/[^/]+$/;
const ATTACHMENT_CONTENT_PATH = /^\/api\/attachments\/[^/]+\/content$/;
const BACKGROUND_PATH = '/api/user/background';

export function remoteImageCachePolicy(uri: string): RemoteImageCachePolicy {
  let url: URL;
  try {
    url = new URL(uri, PARSE_BASE);
  } catch {
    return 'memory';
  }
  const versioned = (url.searchParams.get('v') ?? '') !== '';
  if (VERSIONED_PORTRAIT_PATH.test(url.pathname)) return versioned ? 'memory-disk' : 'memory';
  if (ATTACHMENT_CONTENT_PATH.test(url.pathname)) return 'memory-disk';
  if (url.pathname === BACKGROUND_PATH) return versioned ? 'memory-disk' : 'memory';
  return 'memory';
}

function sameOrigin(serverUrl: string, uri: string): boolean {
  if (!serverUrl) return false;
  try {
    return new URL(serverUrl).origin === new URL(uri).origin;
  } catch {
    return false;
  }
}

/**
 * 서버 상대 경로는 서버 주소를 붙이고, 같은 출처일 때만 Bearer 머리를 단다.
 * 바깥 주소(구글 사진, 슬랙 CDN)에는 토큰을 보내지 않는다.
 */
export function resolveRemoteImageSource(
  uri: string,
  serverUrl: string | null | undefined,
  jwt: string | null | undefined,
): RemoteImageSource {
  const base = (serverUrl ?? '').replace(/\/$/, '');
  const absolute = uri.startsWith('/') && base ? `${base}${uri}` : uri;
  if (jwt && sameOrigin(base, absolute)) {
    return { uri: absolute, headers: { Authorization: `Bearer ${jwt}` } };
  }
  return { uri: absolute };
}

/** 주소나 머리가 바뀌면 달라지는 식별값. 실패 상태를 풀 때 쓴다. */
export function remoteImageSourceKey(source: { uri?: string; headers?: Record<string, string> } | number): string {
  if (typeof source === 'number') return `asset:${source}`;
  const headers = Object.entries(source.headers ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([source.uri ?? '', headers]);
}
