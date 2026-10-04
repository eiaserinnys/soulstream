import React, { useEffect, useState } from 'react';
import { Image, View, TouchableWithoutFeedback, StyleSheet, type ImageProps } from 'react-native';
import { ImageViewerModal } from '../ImageViewerModal';
const fallback = require('../../../assets/settings-wallpaper-fallback.jpg');
export function SettingsPhoto({ source, style, testID, expandable = false, ...props }: Omit<ImageProps, 'source'> & { source: ImageProps['source'] | null; expandable?: boolean }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const identity = JSON.stringify(source);
  useEffect(() => setFailed(false), [identity]);
  const resolved = !source || failed ? fallback : source;
  const image = <View testID={testID ? `${testID}-frame` : undefined} style={[style, { overflow: 'hidden' }]}>
    <Image {...props} testID={testID} style={[StyleSheet.absoluteFill, { width: '100%', height: '100%' }]} source={resolved} resizeMode="cover" onError={() => setFailed(true)}/>
  </View>;
  return <>{expandable ? <TouchableWithoutFeedback accessibilityRole="button" accessibilityLabel="배경 사진 확대" onPress={() => setOpen(true)}>{image}</TouchableWithoutFeedback> : image}{open ? <ImageViewerModal sources={[resolved]} initialIndex={0} onClose={() => setOpen(false)}/> : null}</>;

}
