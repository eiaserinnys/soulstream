import React, { useEffect } from 'react';
import { ReviewEntryShell } from './ReviewEntryShell';
import { useDeviceType } from '../theme';
import { useUIStore } from '../store/uiStore';
import { cardChecksCardId, cardChecksSessionId } from './fixture-client';

/** The real phone navigator and tablet workspace with a public card fixture. */
export function ReviewCardChecks() {
  const device = useDeviceType();
  useEffect(() => {
    if (device !== 'phone') useUIStore.getState().openCardOverlay(cardChecksCardId, cardChecksSessionId);
  }, [device]);
  return <ReviewEntryShell />;
}
