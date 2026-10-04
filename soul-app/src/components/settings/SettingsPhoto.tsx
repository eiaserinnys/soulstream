import React, { useEffect, useState } from 'react';
import { Image, View, TouchableWithoutFeedback, StyleSheet, type ImageProps } from 'react-native';
import { ImageViewerModal } from '../ImageViewerModal';
const fallback = require('../../../assets/settings-wallpaper-fallback.jpg');
export function SettingsPhoto({ source, style, testID, expandable = false, onFailureChange, ...props }: Omit<ImageProps, 'source'> & { source: ImageProps['source'] | null; expandable?: boolean; onFailureChange?(failed: boolean): void }) {
  const [open, setOpen] = useState(false);
  const [failedIdentity, setFailedIdentity] = useState<string | null>(null);
  const identity = JSON.stringify(source);
  useEffect(() => setFailedIdentity(null), [identity]);
  const failed = Boolean(source) && failedIdentity === identity;
  useEffect(() => { onFailureChange?.(failed); }, [failed, identity, onFailureChange]);
  const resolved = !source || failed ? fallback : source;
  const image = <View testID={testID ? `${testID}-frame` : undefined} style={[style, { overflow: 'hidden' }]}>
    <Image {...props} testID={testID} style={[StyleSheet.absoluteFill, { width: '100%', height: '100%' }]} source={resolved} resizeMode="cover" accessibilityLabel={failed ? '사진을 불러오지 못해 예시 이미지를 표시합니다.' : props.accessibilityLabel} onError={() => { if (source && !failed) setFailedIdentity(identity); }}/>
  </View>;
  return <>{expandable ? <TouchableWithoutFeedback accessibilityRole="button" accessibilityLabel="배경 사진 확대" accessibilityHint={failed ? '사진을 불러오지 못해 예시 이미지를 표시합니다.' : undefined} onPress={() => setOpen(true)}>{image}</TouchableWithoutFeedback> : image}{open ? <ImageViewerModal sources={[resolved]} initialIndex={0} onClose={() => setOpen(false)}/> : null}</>;

}
