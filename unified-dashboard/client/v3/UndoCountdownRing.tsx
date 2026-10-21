import { useState, type CSSProperties } from 'react';
import { Clock } from 'lucide-react';

export function UndoCountdownRing({ expiresAt, durationMs }: { expiresAt: number; durationMs: number }) {
  const [elapsed] = useState(() => Math.max(0, Math.min(durationMs, durationMs - (expiresAt - Date.now()))));
  return <span className="pas-undo-ring" aria-hidden="true" style={{
    '--pas-undo-ms': `${durationMs}ms`, animationDelay: `-${elapsed}ms`,
  } as CSSProperties}>
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle className="pas-undo-ring-track" cx="12" cy="12" r="11" pathLength={100} />
      <circle className="pas-undo-ring-fill" cx="12" cy="12" r="11" pathLength={100} />
    </svg>
    <Clock className="pas-undo-ring-clock" aria-hidden="true" />
  </span>;
}
