import { Image } from 'expo-image';
import { Image as NativeImage, type ImageSize, type ImageURISource } from 'react-native';
import { remoteImageCachePolicy } from './remote-image';

/**
 * 화면이 디스크 캐시로 그리는 주소(memory-disk)만 같은 캐시를 타도록 expo-image로 크기를 잰다.
 * Image.loadAsync는 캐시 정책을 받지 않고 iOS에서 늘 디스크에 남기므로,
 * memory로 그리는 주소는 디스크에 낡은 크기가 남지 않게 예전 방식(getSizeWithHeaders)을 지킨다.
 */
export async function getAttachmentImageSize(source: ImageURISource): Promise<ImageSize> {
  if (!source.uri) throw new Error('Image source has no URI');
  if (remoteImageCachePolicy(source.uri) !== 'memory-disk') {
    return NativeImage.getSizeWithHeaders(source.uri, source.headers ?? {});
  }
  const image = await Image.loadAsync({ uri: source.uri, ...(source.headers ? { headers: source.headers } : {}) });
  return { width: image.width, height: image.height };
}
