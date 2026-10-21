import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import type { reportStyles } from './persistentReportStyles';
import { ReportComposerFocusContext, useReportComposerScroll } from './useReportComposerScroll';
/** Only the reading block scrolls; the sheet footer is its sibling. */
export function PersistentReportReading({ current, styles, children, onHeight }: {
  current: boolean; styles: ReturnType<typeof reportStyles>; children: React.ReactNode; onHeight(height: number): void;
}) {
  const { scroll, onFocusChange, keepComposerVisible } = useReportComposerScroll();
  const size = useRef({ view: 0, content: 0, top: 0 });
  const [below, setBelow] = useState(false);
  const overflow = size.current.content > size.current.view && size.current.view > 0;
  const update = () => setBelow(size.current.content - size.current.top > size.current.view + 1);
  useEffect(() => { if (current && overflow) scroll.current?.flashScrollIndicators(); }, [current, overflow]);
  return <View testID="report-scroll-frame" style={styles.scroll}>
    <ScrollView ref={scroll} testID="report-scroll" style={styles.scroll} contentContainerStyle={styles.body}
      keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator
      onLayout={event => { size.current.view = event.nativeEvent.layout.height; update(); keepComposerVisible(); }}
      onContentSizeChange={(_, height) => { size.current.content = height; onHeight(height); update(); keepComposerVisible(); }}
      onScroll={event => { size.current.top = event.nativeEvent.contentOffset.y; update(); }} scrollEventThrottle={16}>
      <ReportComposerFocusContext.Provider value={onFocusChange}>{children}</ReportComposerFocusContext.Provider>
    </ScrollView>
    {below ? <View testID="report-more-below" pointerEvents="none" style={styles.more} /> : null}
  </View>;
}
