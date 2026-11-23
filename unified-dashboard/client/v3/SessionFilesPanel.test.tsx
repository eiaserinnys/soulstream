/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionFilesPanel, useSessionFiles } from './SessionFilesPanel';
import { reviewSessionFiles } from './components-review-fixtures';

vi.mock('@seosoyoung/soul-ui', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  DashboardIconCap: ({ label, children, ...props }: any) => <button aria-label={label} {...props}>{children}</button>,
  DisclosureActionIcon: () => <span/>,
  FrameLoading: ({ label }: any) => <div role="status">{label}</div>,
  formatWorkspaceTime: (value: string) => value,
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
  it('hides zero additions on a deleted file', async () => {
    await render({ ...reviewSessionFiles, files: [{ ...reviewSessionFiles.files[2], git_status: 'deleted', added: 0, deleted: 7 }] });
    const row = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('event_outbox.ts'))!;
    expect(row.textContent).toContain('−7');
    expect(row.textContent).not.toContain('+0');
  });
  it('separates session files from other changes and starts both secondary groups collapsed', async () => {
    await render(reviewSessionFiles);
    const session = [...host.querySelectorAll('button')].find(el => el.textContent?.includes('이번 세션'));
    const other = [...host.querySelectorAll('button')].find(el => el.textContent?.includes('다른 변경'));
    expect(session?.getAttribute('aria-expanded')).toBe('true');
    expect(other?.getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).not.toContain('config.ts');
    expect(host.textContent).toContain('읽기만 한 파일');
  });
  it('classifies read changes, hides empty sections and places the partial badge in the session header', async () => {
    const read = { ...reviewSessionFiles.files[0], path: 'read.ts', read: true };
    await render({ ...reviewSessionFiles, files: [read] });
    const session = [...host.querySelectorAll('button')].find(el => el.textContent?.includes('이번 세션'))!;
    expect(session.textContent).toContain('0개');
    expect(session.textContent).toContain('일부');
    expect(host.textContent).not.toContain('읽음 일부');
    expect(host.textContent).not.toContain('다른 변경');
    click([...host.querySelectorAll('button')].find(el => el.textContent?.includes('읽기만 한 파일'))!);
    expect(host.textContent).toContain('read.ts');
    expect(host.textContent).toContain('dispatcher.ts');
    await render({ ...reviewSessionFiles, files: [], read_only: [], attribution: 'full' });
    expect(host.textContent).not.toContain('이번 세션');
    expect(host.textContent).not.toContain('다른 변경');
  });
  it('opens a diff in place, aborts the previous request, and refreshes only for changed snapshot values', async () => {
    const requests: { url: string; signal: AbortSignal }[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, options: { signal: AbortSignal }) => {
      requests.push({ url, signal: options.signal });
      return new Promise(() => {});
    }));
    await render(reviewSessionFiles);
    const buttons = () => [...host.querySelectorAll('button')];
    const first = buttons().find(el => el.textContent?.includes('event_outbox.ts'))!;
    click(first);
    expect(first.getAttribute('aria-expanded')).toBe('true');
    expect(requests[0].url).toBe('/api/sessions/a%2Fb/workspace/diff?path=soul-server-ts%2Fsrc%2Fupstream%2Fevent_outbox.ts');
    await render({ ...reviewSessionFiles });
    expect(requests).toHaveLength(1);
    await render({ ...reviewSessionFiles, files: reviewSessionFiles.files.map(file => file.path.endsWith('event_outbox.ts') ? { ...file, added: 43 } : file) });
    expect(requests).toHaveLength(2);
    expect(requests[0].signal.aborted).toBe(true);
    click(buttons().find(el => el.textContent?.includes('outbox_retry.ts'))!);
    expect(requests[1].signal.aborted).toBe(true);
    expect(first.getAttribute('aria-expanded')).toBe('false');
    expect(requests).toHaveLength(3);
    click(buttons().find(el => el.textContent?.includes('outbox_retry.ts'))!);
    expect(requests[2].signal.aborted).toBe(true);
  });
  it('opens read-only, committed, image and non-git rows directly in the viewer', async () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    const base = reviewSessionFiles.files[2];
    for (const file of [
      { ...base, path: 'committed.ts', git_status: null },
      { ...base, path: 'image.png' },
    ] as typeof reviewSessionFiles.files) {
      await render({ ...reviewSessionFiles, files: [file], read_only: [] });
      click([...host.querySelectorAll('button')].find(el => el.textContent?.includes(file.path))!);
      expect(host.querySelector('[data-testid="viewer"]')?.textContent).toContain(encodeURIComponent(file.path));
    }
    await render({ ...reviewSessionFiles, snapshot: { ...reviewSessionFiles.snapshot!, state: 'not_git' }, files: [{ ...base, path: 'nongit.ts' }] });
    click([...host.querySelectorAll('button')].find(el => el.textContent?.includes('nongit.ts'))!);
    expect(host.querySelector('[data-testid="viewer"]')?.textContent).toContain('nongit.ts');
    expect(request).not.toHaveBeenCalled();
  });
  it('shows activity, new files and line counts, and opens read-only files with the original URL', async () => {
    await render(reviewSessionFiles);
    expect(host.textContent).toContain('+42'); expect(host.textContent).toContain('−18'); expect(host.textContent).toContain('새');
    expect([...host.querySelectorAll('[data-activity]')].map(el => el.getAttribute('data-activity'))).toEqual(['commit', 'write', 'write', 'read']);
    expect(host.textContent).not.toContain('dispatcher.ts');
    click([...host.querySelectorAll('button')].find(el => el.textContent?.includes('읽기만 한 파일'))!);
    click([...host.querySelectorAll('button')].find(el => el.textContent?.includes('dispatcher.ts'))!);
    expect(host.querySelector('[data-testid="viewer"]')?.textContent).toContain('/api/sessions/a%2Fb/workspace/file?path=soul-server-ts%2Fsrc%2Fupstream%2Fdispatcher.ts');
    expect(host.querySelector('[data-testid="viewer"]')?.textContent).toContain('&download=true|null');
  });
  it('renders offline, not-git, unsupported and failure in the panel', async () => {
    await render({ ...reviewSessionFiles, node: { ...reviewSessionFiles.node, status: 'offline' } }); expect(host.textContent).toContain('노드 끊김');
    await render({ ...reviewSessionFiles, snapshot: { ...reviewSessionFiles.snapshot!, state: 'not_git' }, files: [] }); expect(host.textContent).toContain('Git 작업 폴더가 아닙니다');
    await render({ ...reviewSessionFiles, node: { ...reviewSessionFiles.node, status: 'unsupported' }, snapshot: null }); expect(host.textContent).toContain('지원하지 않습니다');
    await render({ ...reviewSessionFiles, node: { ...reviewSessionFiles.node, status: 'no_workspace' }, snapshot: null }); expect(host.textContent).toContain('작업 폴더가 없습니다');
    await render(null, true); expect(host.textContent).toContain('다시 시도');
  });
  it('shows committed activity even when the file has subsequent git changes', async () => {
    await render({ ...reviewSessionFiles, files: [{ ...reviewSessionFiles.files[0], wrote: true, committed: true }] });
    expect(host.querySelector('[data-activity="commit"]')).not.toBeNull();
  });
  it.each([0, 5])('opens a text file using its current size rather than snapshot size %s', async size => {
    await render({ ...reviewSessionFiles, files: [{ ...reviewSessionFiles.files[0], size, wrote: true, git_status: null }] });
    click([...host.querySelectorAll('button')].find(el => el.textContent?.includes('config.ts'))!);
    expect(host.querySelector('[data-testid="viewer"]')?.textContent).toContain('&download=true|null');
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
