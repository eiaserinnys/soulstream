import { Platform, type ImageURISource } from 'react-native';
import { cardImageSource } from './card-image-source';

/** Native chat images need the same-origin Bearer header; web images use the signed-in browser cookie. */
export function chatImageSource(
  url: string,
  serverUrl: string,
  jwt: string | null,
  platform: typeof Platform.OS = Platform.OS,
): ImageURISource {
  return cardImageSource(url, serverUrl, platform === 'web' ? null : jwt);
}
