import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { CardDetailPane, cardRequestMarkdown } from "./CardDetailPane";
const lookup = vi.hoisted(() => ({ sessions: [] as import("@seosoyoung/soul-ui").SessionSummary[], loading: false }));
vi.mock("@seosoyoung/soul-ui", async importOriginal => {
 const actual = await importOriginal<typeof import("@seosoyoung/soul-ui")>();
 return { ...actual, useSessionListProvider: vi.fn(() => lookup) };
});
// SSR reads Zustand initial state; model the client snapshot with the same selector.
vi.mock("@seosoyoung/soul-ui/cards/card-store", async importOriginal => {
 const actual = await importOriginal<typeof import("@seosoyoung/soul-ui/cards/card-store")>();
 return {useCardStore: Object.assign((selector: (state: ReturnType<typeof actual.useCardStore.getState>) => unknown) => selector(actual.useCardStore.getState()), actual.useCardStore)};
});
const seed = (status: string, blockedKind: string | null=null) => {
 const card={id:"c",folderId:"f",title:"제목",request:"고정 원문",brief:"**해석**",status,blockedKind,version:1};
 useCardStore.setState({byId:{c:card as never},details:{c:{card,reports:[{id:"new",title:"새 보고",format:"html",body:"<h1>결론</h1>",createdAt:"2026-09-30"},{id:"old",title:"옛 보고",format:"markdown",body:"이전",createdAt:"2026-09-29"}],questions:[{id:"q",text:"어느 쪽?",options:["A","B"],answer:null},{id:"answered",text:"확인?",answer:"예"}],sessions:[]} as never}});
};
afterEach(()=>{useCardStore.getState().reset();lookup.sessions=[];lookup.loading=false;});
function render(status:string, kind:string|null=null){seed(status,kind);return renderToStaticMarkup(<CardDetailPane cardId="c" folders={[]} onClose={vi.fn()} onOpenSession={vi.fn()} />);}
describe("card detail",()=>{
 it("uses section counts and the folder empty-state language",()=>{
  seed("running");useCardStore.setState(s=>({details:{c:{...s.details.c,reports:[],questions:[]}}}));
  const html=renderToStaticMarkup(<CardDetailPane cardId="c" folders={[]} onClose={vi.fn()} onOpenSession={vi.fn()}/>);
  for(const text of ["아직 보고가 없습니다.","질문이 없습니다.","아직 세션이 없습니다.","0회"])expect(html).toContain(text);
  expect(html.match(/v3-detail-section-head/g)).toHaveLength(5);
 });
 it("renders one root and 33 children through the folder tree rows",()=>{
  seed("running");lookup.sessions=Array.from({length:34},(_,i)=>({agentSessionId:`s${i}`,callerSessionId:i?"s0":undefined,displayName:`세션 ${i}`,status:"completed",eventCount:2,createdAt:`2026-09-30T00:00:${String(i).padStart(2,"0")}Z`,updatedAt:"2026-09-30T00:01:00Z"}));
  useCardStore.setState(s=>({details:{c:{...s.details.c,sessions:lookup.sessions.map(s=>({sessionId:s.agentSessionId,callerSessionId:s.callerSessionId,updatedAt:s.updatedAt})) as never}}}));
  const html=renderToStaticMarkup(<CardDetailPane cardId="c" folders={[]} onClose={vi.fn()} onOpenSession={vi.fn()}/>);
  expect(html.match(/class="v3-run-children"/g)).toHaveLength(33);
  expect(html.match(/data-session-id=/g)).toHaveLength(34);
  expect(html).toContain("34회");
  expect(html.indexOf('data-session-id="s33"')).toBeLessThan(html.indexOf('data-session-id="s1"'));
 });
 it("shows folder loading rows for a linked session missing from catalog",()=>{
  seed("running");lookup.loading=true;
  useCardStore.setState(s=>({details:{c:{...s.details.c,sessions:[{sessionId:"missing"}] as never}}}));
  const html=renderToStaticMarkup(<CardDetailPane cardId="c" folders={[]} onClose={vi.fn()} onOpenSession={vi.fn()}/>);
  expect(html).toContain('aria-label="세션 정보 불러오는 중"');expect(html).toContain('aria-busy="true"');
 });
 it("renders attached images and documents through markdown while preserving the request text",()=>{
  expect(cardRequestMarkdown("요청\n첨부: 참고.png(https://example.test/file?path=png)")).toBe("요청\n첨부: ![참고.png](https://example.test/file?path=png)");
  expect(cardRequestMarkdown("첨부: 문서.pdf(https://example.test/file?path=pdf)")).toBe("첨부: [문서.pdf](https://example.test/file?path=pdf)");
  seed("queued");useCardStore.setState(s=>({byId:{...s.byId,c:{...s.byId.c,request:"**강조 없이 원문 그대로**"}}}));
  const html=renderToStaticMarkup(<CardDetailPane cardId="c" folders={[]} onClose={vi.fn()} onOpenSession={vi.fn()}/>);
  expect(html).toContain("**강조 없이 원문 그대로**");
 });
 it("renders all five sections, immutable request, newest expanded report, sandboxed HTML and questions",()=>{
  const html=render("blocked","question");
  for(const text of ["요청 원문","해석과 경과","보고","질문","세션","고정 원문","어느 쪽?","확인?","예"]) expect(html).toContain(text);
  expect(html).toContain('sandbox="allow-scripts"');
  expect(html.indexOf("새 보고")).toBeLessThan(html.indexOf("옛 보고"));
  expect(html).toContain('data-report-id="new" open=""');
  expect(html).not.toContain('data-report-id="old" open=""');
  expect(html).toContain('aria-label="확인"');
 });
 it.each([["review",null,["완료","반려"]],["todo",null,["맡기기"]],["queued",null,["대기열에서 빼기"]],["blocked","limit",["대기열로"]],["blocked","no_report",["대기열로"]]])("exposes %s state actions",(status,kind,labels)=>{const html=render(status,kind);for(const label of labels)expect(html).toContain(`aria-label="${label}"`);});
 it("uses the same content layout inline and overlay",()=>{seed("running");const pane=(placement:"inline"|"overlay")=>renderToStaticMarkup(<CardDetailPane cardId="c" folders={[]} placement={placement} onClose={vi.fn()} onOpenSession={vi.fn()}/>);expect(pane("inline").match(/data-card-section="[^"]+"/g)).toEqual(pane("overlay").match(/data-card-section="[^"]+"/g));});
});
