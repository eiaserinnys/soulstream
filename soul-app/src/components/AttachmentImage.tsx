import React, { useState } from 'react';
import { Image, TouchableWithoutFeedback, type ImageSourcePropType } from 'react-native';
import { useTokens } from '../theme';
import { ImageViewerModal } from './ImageViewerModal';

/** The thumbnail is the existing chat attachment Image, with a viewer on tap. */
export function AttachmentImage({ source, sources = [source], index = 0, testID, accessibilityLabel, variant = 'default' }: {
  source: ImageSourcePropType; sources?: ImageSourcePropType[]; index?: number; testID?: string; accessibilityLabel: string;
  variant?: 'default' | 'cardCheckItem';
}) {
  const t = useTokens();
  const [open, setOpen] = useState(false);
  const dimensions = variant === 'cardCheckItem' ? { width: 104, height: 60 } : { width: 200, height: 200 };
  return <>
    <TouchableWithoutFeedback onPress={() => setOpen(true)} accessibilityRole="button">
      <Image testID={testID} source={source} style={{ ...dimensions, borderRadius: t.radius.md, backgroundColor: t.colors.border }}
        resizeMode="cover" accessible accessibilityLabel={accessibilityLabel} />
    </TouchableWithoutFeedback>
    {open ? <ImageViewerModal sources={sources} initialIndex={index} onClose={() => setOpen(false)} /> : null}
  </>;
}
