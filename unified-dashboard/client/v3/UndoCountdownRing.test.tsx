/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UndoCountdownRing } from './UndoCountdownRing';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T00:00:00.000Z'));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

it('starts at the elapsed point and stays hidden from the accessible button name', () => {
  act(() => root.render(<UndoCountdownRing expiresAt={Date.now() + 3_000} durationMs={5_000} />));
  const ring = host.querySelector<HTMLElement>('.pas-undo-ring')!;
  expect(ring.getAttribute('aria-hidden')).toBe('true');
  expect(ring.style.animationDelay).toBe('-2000ms');
  expect(ring.style.getPropertyValue('--pas-undo-ms')).toBe('5000ms');
  expect(ring.querySelector('.pas-undo-ring-clock')?.getAttribute('aria-hidden')).toBe('true');
});
