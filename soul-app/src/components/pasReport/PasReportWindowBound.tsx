// 카드 #1871: 실제 데이터(이 PAS 판의 장, 완료 훅)를 읽어 보고 창에 물린다. 창이 열려 있는 동안에만 마운트한다.
import React from 'react';
import { PasReportWindow, type PasReportWindowHandle, type PasReportWindowProps } from './PasReportWindow';
import { usePasReportSource } from './usePasReportSource';

export const PasReportWindowBound = React.forwardRef<PasReportWindowHandle, Pick<PasReportWindowProps, 'startCardId' | 'onClose' | 'onOpenCard'>>(
  function PasReportWindowBound(props, ref) {
    const source = usePasReportSource();
    return <PasReportWindow ref={ref} {...source} {...props} />;
  });
