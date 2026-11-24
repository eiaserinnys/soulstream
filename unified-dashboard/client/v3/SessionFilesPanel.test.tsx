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
  it('opens session history for a committed file and refreshes only after activity changes', async () => {
    const request=vi.fn().mockResolvedValue({ok:true,json:async()=>({path:'committed.ts',edits:[{at:'2026-01-01T00:00:00Z',tool:'Edit',kind:'edit',text:'@@ @@\n-old\n+new',line_numbers:false,replace_all:true}],unrecorded:0,truncated:false})});
    vi.stubGlobal('fetch',request);
    const file={...reviewSessionFiles.files[1],path:'committed.ts',last_activity_at:'2026-01-01T00:00:00Z'};
    const data={...reviewSessionFiles,files:[file],read_only:[]};
    await render(data);
    await act(async()=>click([...host.querySelectorAll('button')].find(button=>button.textContent?.includes('committed.ts'))!));
    expect(request.mock.calls[0][0]).toContain('/workspace/session-diff?path=committed.ts');
    expect(host.textContent).toContain('1/1'); expect(host.textContent).toContain('고침, 모두 바꿈');
    expect(host.querySelector('[role="tablist"]')).toBeNull();
    await render({...data}); expect(request).toHaveBeenCalledTimes(1);
    await render({...data,files:[{...file,last_activity_at:'2026-01-02T00:00:00Z'}]}); expect(request).toHaveBeenCalledTimes(2);
  });
  it('starts with live diff, switches to history and aborts the old request', async () => {
    const signals:AbortSignal[]=[]; const urls:string[]=[];
    vi.stubGlobal('fetch',vi.fn((url:string,options:{signal:AbortSignal})=>{urls.push(url);signals.push(options.signal);return new Promise(()=>{});}));
    await render({...reviewSessionFiles,files:[reviewSessionFiles.files[2]],read_only:[]});
    click([...host.querySelectorAll('button')].find(button=>button.textContent?.includes('event_outbox.ts'))!);
    expect(urls[0]).toContain('/workspace/diff?');
    click([...host.querySelectorAll('[role="tab"]')].find(tab=>tab.textContent==='세션 기록')!);
    expect(signals[0].aborted).toBe(true); expect(urls[1]).toContain('/workspace/session-diff?');
  });
  it('shows a deleted workspace list but disables rows without recorded diffs', async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({path:'gone.ts',edits:[],unrecorded:2,truncated:true})}));
    await render({...reviewSessionFiles,root:null,node:{...reviewSessionFiles.node,status:'no_workspace'},snapshot:null,files:[{...reviewSessionFiles.files[1],path:'gone.ts'},{...reviewSessionFiles.files[1],path:'image.png'}],read_only:[{path:'read.txt',size:null,last_read_at:null}]});
    expect(host.textContent).toContain('작업 폴더가 지워져');
    expect([...host.querySelectorAll('button')].some(button=>button.textContent?.includes('image.png'))).toBe(false);
    await act(async()=>click([...host.querySelectorAll('button')].find(button=>button.textContent?.includes('gone.ts'))!));
    expect(host.textContent).toContain('이 엔진은 고친 내용을 기록에 남기지 않습니다');
    expect(host.textContent).toContain('기록이 길어 오래된 편집은 빠졌습니다');
    expect(host.querySelector('[aria-label="전체 보기"]')).toBeNull();
  });
  it('shows mixed, empty and failed history and retries', async () => {
    const request=vi.fn().mockResolvedValueOnce({ok:false,status:403}).mockResolvedValueOnce({ok:true,json:async()=>({path:'nongit.ts',edits:[{at:'2026-01-01T00:00:00Z',tool:'Write',kind:'write',text:'@@ -0,0 +1,1 @@\n+new',line_numbers:true,replace_all:false}],unrecorded:2,truncated:false})}).mockResolvedValue({ok:true,json:async()=>({path:'nongit.ts',edits:[],unrecorded:0,truncated:false})});
    vi.stubGlobal('fetch',request);
    const file={...reviewSessionFiles.files[1],path:'nongit.ts'};
    const data={...reviewSessionFiles,snapshot:{...reviewSessionFiles.snapshot!,state:'not_git' as const},files:[file],read_only:[]};
    await render(data);
    await act(async()=>click([...host.querySelectorAll('button')].find(button=>button.textContent?.includes('nongit.ts'))!));
    expect(host.textContent).toContain('변경분을 불러오지 못했습니다');
    await act(async()=>click([...host.querySelectorAll('button')].find(button=>button.textContent==='다시 시도')!));
    expect(host.textContent).toContain('전체 씀'); expect(host.textContent).toContain('내용이 기록되지 않은 편집 2번');
    await render({...data,files:[{...file,last_activity_at:'2026-01-03T00:00:00Z'}]});
    expect(host.textContent).toContain('바뀐 내용 없음');
  });
  it('opens image and non-git read-only rows directly in the viewer', async () => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    const base = reviewSessionFiles.files[2];
    for (const file of [
      { ...base, path: 'image.png' },
    ] as typeof reviewSessionFiles.files) {
      await render({ ...reviewSessionFiles, files: [file], read_only: [] });
      click([...host.querySelectorAll('button')].find(el => el.textContent?.includes(file.path))!);
      expect(host.querySelector('[data-testid="viewer"]')?.textContent).toContain(encodeURIComponent(file.path));
    }
    await render({ ...reviewSessionFiles, snapshot: { ...reviewSessionFiles.snapshot!, state: 'not_git' }, files: [{ ...base, path: 'nongit.ts', wrote: false, read: true }] });
    click([...host.querySelectorAll('button')].find(el => el.textContent?.includes('읽기만 한 파일'))!);
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
    await render({ ...reviewSessionFiles, node: { ...reviewSessionFiles.node, status: 'no_workspace' }, snapshot: null, files: [], read_only: [] }); expect(host.textContent).toContain('작업 폴더가 없습니다');
    await render(null, true); expect(host.textContent).toContain('다시 시도');
  });
  it('shows committed activity even when the file has subsequent git changes', async () => {
    await render({ ...reviewSessionFiles, files: [{ ...reviewSessionFiles.files[0], wrote: true, committed: true }] });
    expect(host.querySelector('[data-activity="commit"]')).not.toBeNull();
  });
  it.each([0, 5])('opens a text file using its current size rather than snapshot size %s', async size => {
    await render({ ...reviewSessionFiles, files: [{ ...reviewSessionFiles.files[0], size, wrote: false, read: true, git_status: null }] });
    click([...host.querySelectorAll('button')].find(el => el.textContent?.includes('읽기만 한 파일'))!);
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
