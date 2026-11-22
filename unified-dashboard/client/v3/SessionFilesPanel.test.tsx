/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionFilesPanel, useSessionFiles } from './SessionFilesPanel';
import { reviewSessionFiles } from './components-review-fixtures';

vi.mock('@seosoyoung/soul-ui', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  DashboardIconCap: ({ label, children, ...props }: any) => <button aria-label={label} {...props}>{children}</button>,
  FrameLoading: ({ label }: any) => <div role="status">{label}</div>,
}));
vi.mock('@seosoyoung/soul-ui/components/AttachmentViewer', () => ({
  AttachmentViewer: ({ items, index }: any) => index === null ? null : <div data-testid="viewer">{items[index].previewUrl}|{items[index].originalUrl}|{String(items[index].byteSize)}</div>,
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const click = (button: Element) => act(() => (button as HTMLElement).click());
const render = async (data: typeof reviewSessionFiles | null, error = false, loading = false) => act(async () => root.render(<SessionFilesPanel sessionId="a/b" data={data} loading={loading} error={error} onRefresh={() => {}} onClose={() => {}}/>));

describe('session files panel', () => {
  it('shows activity, new files and line counts, and opens read-only files with the original URL', async () => {
    await render(reviewSessionFiles);
    expect(host.textContent).toContain('+42'); expect(host.textContent).toContain('−18'); expect(host.textContent).toContain('새');
    expect([...host.querySelectorAll('[data-activity]')].map(el => el.getAttribute('data-activity'))).toEqual(['none', 'commit', 'write', 'write', 'read']);
    expect(host.textContent).not.toContain('dispatcher.ts');
    click(host.querySelector('[aria-expanded="false"]')!);
    click([...host.querySelectorAll('button')].find(el => el.textContent?.includes('dispatcher.ts'))!);
    expect(host.querySelector('[data-testid="viewer"]')?.textContent).toContain('/api/sessions/a%2Fb/workspace/file?path=soul-server-ts%2Fsrc%2Fupstream%2Fdispatcher.ts');
    expect(host.querySelector('[data-testid="viewer"]')?.textContent).toContain('&download=true|null');
  });
  it('renders offline, not-git, unsupported and failure in the panel', async () => {
    await render({ ...reviewSessionFiles, node: { ...reviewSessionFiles.node, status: 'offline' } }); expect(host.textContent).toContain('노드 끊김');
    await render({ ...reviewSessionFiles, snapshot: { ...reviewSessionFiles.snapshot!, state: 'not_git' }, files: [] }); expect(host.textContent).toContain('Git 폴더가 아닙니다');
    await render({ ...reviewSessionFiles, node: { ...reviewSessionFiles.node, status: 'unsupported' }, snapshot: null }); expect(host.textContent).toContain('지원하지 않습니다');
    await render({ ...reviewSessionFiles, node: { ...reviewSessionFiles.node, status: 'no_workspace' }, snapshot: null }); expect(host.textContent).toContain('작업 폴더가 없습니다');
    await render(null, true); expect(host.textContent).toContain('다시 시도');
  });
  it('retries pending snapshots ten times and stops when unmounted', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...reviewSessionFiles, snapshot: { ...reviewSessionFiles.snapshot!, state: 'pending' } }) });
    vi.stubGlobal('fetch', request);
    function Harness() { useSessionFiles('components-session'); return null; }
    await act(async () => { root.render(<Harness/>); });
    for (let i = 0; i < 12; i++) await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(request).toHaveBeenCalledTimes(11);
    await act(async () => root.unmount()); root = createRoot(host);
    await act(async () => { root.render(<Harness/>); });
    expect(request).toHaveBeenCalledTimes(12);
    act(() => root.unmount()); root = createRoot(host);
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(request).toHaveBeenCalledTimes(12);
  });
  it('reloads when the session changes or a turn completes', async () => {
    const request = vi.fn(async (_url: string) => ({ ok: true, json: async () => reviewSessionFiles }));
    vi.stubGlobal('fetch', request);
    function Harness({ id, turn }: { id: string; turn: number }) { useSessionFiles(id, turn); return null; }
    await act(async () => root.render(<Harness id="first" turn={0}/>));
    await act(async () => root.render(<Harness id="first" turn={1}/>));
    await act(async () => root.render(<Harness id="second" turn={1}/>));
    expect(request.mock.calls.map(call => call[0])).toEqual(['/api/sessions/first/workspace', '/api/sessions/first/workspace', '/api/sessions/second/workspace']);
  });
});
