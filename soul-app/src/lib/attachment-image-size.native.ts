import { Image } from 'expo-image';
import type { ImageSize, ImageURISource } from 'react-native';

/** 화면이 같은 주소를 그릴 때 쓰는 expo-image 캐시를 같이 타도록 expo-image로 크기를 잰다. */
export async function getAttachmentImageSize(source: ImageURISource): Promise<ImageSize> {
  if (!source.uri) throw new Error('Image source has no URI');
  const image = await Image.loadAsync({ uri: source.uri, ...(source.headers ? { headers: source.headers } : {}) });
  return { width: image.width, height: image.height };
}
