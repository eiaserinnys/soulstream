import { useState } from 'react';
import { DashboardIconCap, PersistentSessionPortraitIcon, PersistentSessionPortraitOffIcon } from '@seosoyoung/soul-ui';

export function PersistentSessionPortraitToggleReviewSample() {
  const [showCharacter, setShowCharacter] = useState(true);
  const label = showCharacter ? '캐릭터 숨기기' : '캐릭터 표시';

  return (
    <DashboardIconCap label={label} onClick={() => setShowCharacter(value => !value)}>
      {showCharacter ? <PersistentSessionPortraitOffIcon /> : <PersistentSessionPortraitIcon />}
    </DashboardIconCap>
  );
}
