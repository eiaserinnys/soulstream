export interface WallpaperImageSource {
  uri: string;
  headers?: { Authorization: string };
}

export function resolveBackgroundImageSource(
  serverUrl: string,
  customImage: string | undefined,
  jwt: string | null,
): WallpaperImageSource | null {
  if (!customImage) return null;
  let uri = customImage;
  if (customImage.startsWith('/')) {
    if (!serverUrl) return null;
    uri = `${serverUrl.replace(/\/$/, '')}${customImage}`;
  }
  if (jwt && isSameOrigin(serverUrl, uri)) {
    return { uri, headers: { Authorization: `Bearer ${jwt}` } };
  }
  return { uri };
}

function isSameOrigin(serverUrl: string, uri: string): boolean {
  if (!serverUrl) return false;
  try {
    return new URL(serverUrl).origin === new URL(uri).origin;
  } catch {
    return false;
  }
}
