import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { CardDetailPane, cardRequestMarkdown } from "./CardDetailPane";
// SSR reads Zustand initial state; model the client snapshot with the same selector.
vi.mock("@seosoyoung/soul-ui/cards/card-store", async importOriginal => {
 const actual = await importOriginal<typeof import("@seosoyoung/soul-ui/cards/card-store")>();
 return {useCardStore: Object.assign((selector: (state: ReturnType<typeof actual.useCardStore.getState>) => unknown) => selector(actual.useCardStore.getState()), actual.useCardStore)};
});
const seed = (status: string, blockedKind: string | null=null) => {
 const card={id:"c",folderId:"f",title:"제목",request:"고정 원문",brief:"**해석**",status,blockedKind,version:1};
 useCardStore.setState({byId:{c:card as never},details:{c:{card,reports:[{id:"new",title:"새 보고",format:"html",body:"<h1>결론</h1>",createdAt:"2026-09-30"},{id:"old",title:"옛 보고",format:"markdown",body:"이전",createdAt:"2026-09-29"}],questions:[{id:"q",text:"어느 쪽?",options:["A","B"],answer:null},{id:"answered",text:"확인?",answer:"예"}],sessions:[]} as never}});
};
afterEach(()=>useCardStore.getState().reset());
function render(status:string, kind:string|null=null){seed(status,kind);return renderToStaticMarkup(<CardDetailPane cardId="c" folders={[]} onClose={vi.fn()} onOpenSession={vi.fn()} />);}
describe("card detail",()=>{
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
