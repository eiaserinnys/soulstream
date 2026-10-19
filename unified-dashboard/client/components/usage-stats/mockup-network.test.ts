// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('same-origin annotations pass through while other server APIs stay mocked', async () => {
  const request = vi.fn(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', request);
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('EventSource', class {});
  const env = await import('../../../mockups/_shell/mock-env');
  const annotation = `${window.location.origin}/api/annotations/public-example`;
  await window.fetch(annotation);
  expect(request).toHaveBeenCalledWith(annotation, undefined);
  expect(env.unmockedRequests()).toEqual([]);
  env.mockApi({ 'GET /api/example': { mocked: true }, 'GET /cogito/example': { mocked: true } });
  expect(await (await window.fetch('/api/example')).json()).toEqual({ mocked: true });
  expect(await (await window.fetch('/cogito/example')).json()).toEqual({ mocked: true });
  expect(request).toHaveBeenCalledTimes(1);
});
