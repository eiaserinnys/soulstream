/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UndoCountdownRing } from './UndoCountdownRing';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let reduceMotion = false;
let mediaListeners: Set<(event: MediaQueryListEvent) => void>;
let mediaQuery: MediaQueryList;

function setReducedMotion(matches: boolean) {
  reduceMotion = matches;
  mediaListeners.forEach(listener => listener({ matches, media: '(prefers-reduced-motion: reduce)' } as MediaQueryListEvent));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T00:00:00.000Z'));
  reduceMotion = false;
  mediaListeners = new Set();
  mediaQuery = {
    media: '(prefers-reduced-motion: reduce)',
    get matches() { return reduceMotion; },
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => mediaListeners.add(listener as (event: MediaQueryListEvent) => void),
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => mediaListeners.delete(listener as (event: MediaQueryListEvent) => void),
  } as unknown as MediaQueryList;
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => mediaQuery) });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

it('starts at the elapsed point and stays hidden from the accessible button name', () => {
  act(() => root.render(<UndoCountdownRing expiresAt={Date.now() + 3_000} durationMs={5_000} />));
  const ring = host.querySelector<HTMLElement>('.pas-undo-ring')!;
  expect(ring.getAttribute('aria-hidden')).toBe('true');
  expect(ring.style.animationDelay).toBe('-2000ms');
  expect(ring.style.getPropertyValue('--pas-undo-ms')).toBe('5000ms');
  expect(ring.querySelector('.pas-undo-ring-clock')?.getAttribute('aria-hidden')).toBe('true');
});

it('renders five discrete segments and follows reduced-motion changes at elapsed-second boundaries', async () => {
  act(() => root.render(<UndoCountdownRing expiresAt={Date.now() + 5_000} durationMs={5_000} />));
  const ring = host.querySelector<HTMLElement>('.pas-undo-ring')!;
  const fill = host.querySelector<SVGCircleElement>('.pas-undo-ring-fill')!;

  act(() => setReducedMotion(true));
  expect(ring.dataset.reducedMotion).toBe('true');
  expect(fill.style.strokeDasharray).toBe('18 2 0 100');
  expect(fill.style.animation).toBe('');

  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(fill.style.strokeDasharray).toBe('18 2 0 100');
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(fill.style.strokeDasharray).toBe('18 2 18 2 18 2 0 100');
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(fill.style.strokeDasharray).toBe('18 2 18 2 18 2 18 2 18 2 0 100');

  act(() => setReducedMotion(false));
  expect(ring.dataset.reducedMotion).toBeUndefined();
});

it('mounts reduced-motion segments at the elapsed point and schedules from expiresAt', async () => {
  reduceMotion = true;
  const expiresAt = Date.now() + 3_000;
  act(() => root.render(<UndoCountdownRing expiresAt={expiresAt} durationMs={5_000} />));
  const fill = host.querySelector<SVGCircleElement>('.pas-undo-ring-fill')!;
  expect(fill.style.strokeDasharray).toBe('18 2 18 2 18 2 0 100');
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(fill.style.strokeDasharray).toBe('18 2 18 2 18 2 18 2 0 100');
});
