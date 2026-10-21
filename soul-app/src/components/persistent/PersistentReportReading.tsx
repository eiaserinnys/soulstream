import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import type { reportStyles } from './persistentReportStyles';
import { ReportComposerFocusContext, useReportComposerScroll } from './useReportComposerScroll';
/** Only the reading block scrolls; the sheet footer is its sibling. */
export function PersistentReportReading({ current, styles, children, header, contentMinHeight, onHeight }: {
  current: boolean; styles: ReturnType<typeof reportStyles>; children: React.ReactNode; header?: React.ReactNode;
  contentMinHeight?: number; onHeight(height: number): void;
}) {
  const { scroll, onFocusChange, keepComposerVisible } = useReportComposerScroll();
  const size = useRef({ view: 0, content: 0, top: 0 });
  const [below, setBelow] = useState(false);
  const overflow = size.current.content > size.current.view && size.current.view > 0;
  const update = () => setBelow(size.current.content - size.current.top > size.current.view + 1);
  useEffect(() => { if (current && overflow) scroll.current?.flashScrollIndicators(); }, [current, overflow]);
  return <View testID="report-scroll-frame" style={styles.scroll}>
    <ReportComposerFocusContext.Provider value={onFocusChange}>
    <ScrollView ref={scroll} testID="report-scroll" style={styles.scroll}
      contentContainerStyle={[styles.body, header === undefined ? undefined : { paddingTop: 0 },
        contentMinHeight === undefined ? undefined : { minHeight: contentMinHeight }]}
      stickyHeaderIndices={header === undefined ? undefined : [0]}
      keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator
      onLayout={event => { size.current.view = event.nativeEvent.layout.height; update(); keepComposerVisible(); }}
      onContentSizeChange={(_, height) => { size.current.content = height; onHeight(height); update(); keepComposerVisible(); }}
      onScroll={event => { size.current.top = event.nativeEvent.contentOffset.y; update(); }} scrollEventThrottle={16}>
      {header === undefined ? children : [
        <View key="head" testID="report-sticky-head" style={styles.stickyHead}>{header}</View>,
        <View key="body">{children}</View>,
      ]}
    </ScrollView>
    </ReportComposerFocusContext.Provider>
    {below ? <View testID="report-more-below" pointerEvents="none" style={styles.more} /> : null}
  </View>;
}
