import type { ImageURISource } from 'react-native';

/** Resolve first, then compare origins so external images never receive JWT. */
export function cardImageSource(url: string, serverUrl: string, jwt: string | null): ImageURISource {
  const uri = serverUrl ? new URL(url, serverUrl).href : url;
  const sameOrigin = serverUrl && new URL(uri).origin === new URL(serverUrl).origin;
  return { uri, ...(jwt && sameOrigin ? { headers: { Authorization: `Bearer ${jwt}` } } : {}) };
}
