import { useEffect, useState, type CSSProperties } from 'react';
import { Clock } from 'lucide-react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function readElapsed(expiresAt: number, durationMs: number) {
  return Math.max(0, Math.min(durationMs, durationMs - (expiresAt - Date.now())));
}

function readReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export function UndoCountdownRing({ expiresAt, durationMs }: { expiresAt: number; durationMs: number }) {
  const [reducedMotion, setReducedMotion] = useState(readReducedMotion);
  const [elapsed, setElapsed] = useState(() => readElapsed(expiresAt, durationMs));

  useEffect(() => {
    const media = window.matchMedia(REDUCED_MOTION_QUERY);
    const update = (matches: boolean) => {
      setElapsed(readElapsed(expiresAt, durationMs));
      setReducedMotion(matches);
    };
    const onChange = (event: MediaQueryListEvent) => update(event.matches);
    media.addEventListener('change', onChange);
    update(media.matches);
    return () => media.removeEventListener('change', onChange);
  }, [durationMs, expiresAt]);

  useEffect(() => {
    if (!reducedMotion) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      const now = Date.now();
      const nextElapsed = readElapsed(expiresAt, durationMs);
      setElapsed(nextElapsed);
      if (nextElapsed >= durationMs) return;
      const nextBoundary = Math.min(durationMs, (Math.floor(nextElapsed / 1_000) + 1) * 1_000);
      timer = setTimeout(update, Math.max(0, expiresAt - durationMs + nextBoundary - now));
    };
    update();
    return () => { if (timer !== null) clearTimeout(timer); };
  }, [durationMs, expiresAt, reducedMotion]);

  const elapsedNow = readElapsed(expiresAt, durationMs);
  const completedSegments = Math.min(5, Math.floor(elapsed / 1_000) + 1);
  const segmentDasharray = `${Array.from({ length: completedSegments }, () => '18 2').join(' ')} 0 100`;

  return <span className="pas-undo-ring" aria-hidden="true" data-reduced-motion={reducedMotion || undefined} style={{
    '--pas-undo-ms': `${durationMs}ms`, animationDelay: `-${elapsedNow}ms`,
  } as CSSProperties}>
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle className="pas-undo-ring-track" cx="12" cy="12" r="11" pathLength={100} />
      <circle className="pas-undo-ring-fill" cx="12" cy="12" r="11" pathLength={100}
        style={reducedMotion ? { strokeDasharray: segmentDasharray } : undefined} />
    </svg>
    <Clock className="pas-undo-ring-clock" aria-hidden="true" />
  </span>;
}
