import { fireEvent, type render } from '@testing-library/react-native';

/** Drive the native layout boundary before testing report interaction.
 * Includes offscreen/hidden measuring sheets, while ordinary assertions keep
 * the default accessibility queries. No store or report state is injected. */
export function measurePersistentReports(screen: ReturnType<typeof render>, {
  width = 390, readingHeight = 100, footerHeight = 80,
}: { width?: number; readingHeight?: number; footerHeight?: number } = {}) {
  const track = screen.queryByTestId('report-track', { includeHiddenElements: true });
  if (!track) return;
  fireEvent(track, 'layout', { nativeEvent: { layout: { width } } });
  const sheets = screen.getAllByTestId(/^report-sheet-/, { includeHiddenElements: true });
  for (const sheet of sheets) {
    const reading = sheet.findByProps({ testID: 'report-reading' });
    fireEvent(reading, 'layout', { nativeEvent: { layout: { height: readingHeight } } });
    const scroll = sheet.findAllByProps({ testID: 'report-scroll' })[0];
    if (scroll) {
      fireEvent(scroll, 'layout', { nativeEvent: { layout: { height: readingHeight } } });
      fireEvent(scroll, 'contentSizeChange', width, readingHeight);
    }
    const footer = sheet.findAllByProps({ testID: 'report-footer' })[0];
    if (footer) fireEvent(footer, 'layout', { nativeEvent: { layout: { height: footerHeight } } });
  }
}
