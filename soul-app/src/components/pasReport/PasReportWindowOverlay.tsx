// 카드 #1871: 태블릿에서 보고 창을 여는 길. PAS 화면(TabletNavigator의 PersistentSession)이 카드 패널을 여는 겹침과 같은 틀(CardPanelOverlayFrame)이다.
// 카드 패널은 이 창 위에 겹쳐 열리고, 닫으면 같은 안건 같은 스크롤로 돌아온다.
import React, { useEffect, useRef, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { getFolderWorkspaceOverlayWidth } from '../../lib/folder-workspace-layout';
import { DUO_SIDE_BAND_WIDTH } from '../../navigation/duoSideBand';
import { CardPanelOverlayFrame } from '../planner/FolderWorkspaceReadOverlay';
import type { PasReportWindowHandle } from './PasReportWindow';
import { PasReportWindowBound } from './PasReportWindowBound';

export interface PasReportWindowOverlayHandle { back(): boolean }

export const PasReportWindowOverlay = React.forwardRef<PasReportWindowOverlayHandle, {
  open: { startCardId: string | null } | null;
  bottomSafeAreaInset: number;
  sheetTop?: number;
  railBand?: boolean;
  onClose(): void;
  onOpenCard(cardId: string): void;
}>(function PasReportWindowOverlay({ open, bottomSafeAreaInset, sheetTop, railBand = false, onClose, onOpenCard }, ref) {
  const { width } = useWindowDimensions();
  const windowRef = useRef<PasReportWindowHandle>(null);
  // 닫는 애니메이션이 끝날 때까지 마지막 안건을 그린다. 다시 열면 새 안건으로 시작한다.
  const [rendered, setRendered] = useState(open);
  // 열 때마다 새 창이다. 닫는 애니메이션 중에 다시 열어도 새 시작 안건으로 선다.
  const openSeq = useRef(0);
  const lastOpen = useRef(open);
  if (open !== null && open !== lastOpen.current) openSeq.current += 1;
  lastOpen.current = open;
  useEffect(() => { if (open) setRendered(open); }, [open]);
  React.useImperativeHandle(ref, () => ({ back: () => open !== null && (windowRef.current?.back() ?? false) }), [open]);
  const shown = open ?? rendered;
  if (!shown) return null;
  const sheetRight = railBand ? DUO_SIDE_BAND_WIDTH : 0;
  const sheetWidth = railBand ? width - DUO_SIDE_BAND_WIDTH : getFolderWorkspaceOverlayWidth(width);
  return <CardPanelOverlayFrame visible={open !== null} width={sheetWidth} sheetRight={sheetRight} sheetTop={sheetTop} direction="column"
    onClose={onClose} onHidden={() => { if (open === null) setRendered(null); }} testID="pas-report-overlay"
    chatPaneMinimumBottomPadding={bottomSafeAreaInset}>
    <PasReportWindowBound key={openSeq.current} ref={windowRef} startCardId={shown.startCardId} onClose={onClose} onOpenCard={onOpenCard} />
  </CardPanelOverlayFrame>;
});
