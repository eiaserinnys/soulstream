import { useMemo, useState, type ReactNode } from 'react';
import type { ImageSourcePropType } from 'react-native';
import { Image as ExpoImage, type ImageProps as ExpoImageProps } from 'expo-image';
import { remoteImageCachePolicy, remoteImageSourceKey } from '../lib/remote-image';

export type RemoteImageProps = Omit<ExpoImageProps, 'source' | 'cachePolicy' | 'onError'> & {
  /** 원격 {uri, headers}이거나 로컬 asset. */
  source: ImageSourcePropType;
  /** 이 주소의 그림이 실패하면 대신 보이는 것. 주소가 바뀌면 실패 상태가 풀려 그림을 다시 그린다. */
  fallback?: ReactNode;
  onError?(): void;
};

/**
 * 앱의 원격 이미지 부품 하나. expo-image를 감싸 디스크 캐시를 쓴다.
 * 캐시 정책은 주소 꼴로 정한다(`remoteImageCachePolicy`): 버전 주소만 memory-disk, 나머지는 memory.
 */
export function RemoteImage({ source, fallback, onError, contentFit = 'cover', ...rest }: RemoteImageProps) {
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const resolved = Array.isArray(source) ? source[0] : source;
  const key = remoteImageSourceKey(typeof resolved === 'number' ? resolved : (resolved as { uri?: string; headers?: Record<string, string> }));
  const cachePolicy = useMemo(() => {
    if (typeof resolved === 'number') return undefined;
    return remoteImageCachePolicy((resolved as { uri?: string }).uri ?? '');
  }, [resolved]);
  if (fallback !== undefined && failedKey === key) return <>{fallback}</>;
  return <ExpoImage
    {...rest}
    source={resolved as ExpoImageProps['source']}
    contentFit={contentFit}
    cachePolicy={cachePolicy}
    onError={() => {
      setFailedKey(key);
      onError?.();
    }}
  />;
}
