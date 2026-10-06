import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { CardTimeline } from "./CardTimeline";
import { CardSessionHistory } from "./CardSessionHistory";
import { CardDetailPane, cardRequestMarkdown } from "./CardDetailPane";
vi.mock("./useCardSessionPages",async original=>({...await original<typeof import("./useCardSessionPages")>(),useCardSessionPages:()=>lookup}));
vi.mock("@seosoyoung/soul-ui/cards/CardSessionVirtualList",()=>({CardSessionVirtualList:({data,itemContent}:any)=><div>{data.map((row:any,i:number)=><div key={i}>{itemContent(i,row)}</div>)}</div>}));
const lookup = vi.hoisted(() => ({ sessions: [] as import("@seosoyoung/soul-ui").SessionSummary[], loading: false }));
vi.mock("@seosoyoung/soul-ui", async importOriginal => ({...await importOriginal<typeof import("@seosoyoung/soul-ui")>(), useAuth: () => ({user:{picture:"https://example.test/user.png"}}), useSessionListProvider: vi.fn(() => lookup)}));
vi.mock("@seosoyoung/soul-ui/cards/card-store", async importOriginal => {
 const actual = await importOriginal<typeof import("@seosoyoung/soul-ui/cards/card-store")>();
 return {useCardStore: Object.assign((selector: (state: ReturnType<typeof actual.useCardStore.getState>) => unknown) => selector(actual.useCardStore.getState()), actual.useCardStore)};
});
function seed(status="review") {
 const card={id:"c",folderId:"f",title:"제목",request:"고정 원문",brief:"**해석**",status,blockedKind:null,version:1,createdAt:"2026-09-28",nodeId:"eiaserinnys",assigneeAgentId:"roselin"};
 useCardStore.setState({byId:{c:card as never},details:{c:{card,reports:[{id:"new",title:"새 보고",format:"html",body:"<p>결론</p>",createdAt:"2026-09-30"},{id:"old",title:"옛 보고",format:"markdown",body:"이전\n\n![캡처](https://example.test/a.png)",createdAt:"2026-09-29"}],questions:[{id:"q",text:"어느 쪽?",options:["A","B"],answer:"A",askedAt:"2026-09-28T01:00:00Z",answeredAt:"2026-09-28T02:00:00Z"}],comments:[{id:"comment",authorKind:"user",kind:"spoken",body:"추가 지시",createdAt:"2026-09-30T03:00:00Z"}],sessions:[]} as never}});
}
afterEach(()=>{useCardStore.getState().reset();lookup.sessions=[];lookup.loading=false;});
const renderPane=()=>renderToStaticMarkup(<CardDetailPane cardId="c" folders={[]} onClose={vi.fn()} onOpenSession={vi.fn()}/>);
const render=()=>{const s=useCardStore.getState();return renderToStaticMarkup(<CardTimeline card={s.byId.c} detail={s.details.c} portraitUrl="" pending={false} onAnswer={()=>{}}/>);};
describe("card final UX",()=>{
 it("orders request, questions, answer, reports and comments oldest first in shared chat bubbles",()=>{
  seed();const html=render();
  for(const text of ["지시","질문","답","보고","커멘트","대화에서","추가 지시"])expect(html).toContain(text);
  expect(html.match(/data-slot="chat-message-row"/g)).toHaveLength(6);
  expect(html.indexOf("옛 보고")).toBeLessThan(html.indexOf("새 보고"));
  expect(html).not.toContain('sandbox="allow-scripts"');
  expect(html).not.toContain('data-report-id="new" open');
  expect(renderPane()).toContain('aria-label="커멘트"');
  expect(html).not.toContain('aria-label="카드 섹션"');

 });
 it.each(["review","running","todo","queued"])("uses the existing action for startable and completion states (%s)",status=>{
  seed(status);const html=renderPane();
  const label=status==='todo'||status==='queued'?'시작하기':'완료';
  expect(html).toContain('aria-label="'+label+'"');
  expect(html).not.toContain('aria-label="반려"');expect(html).not.toContain('aria-label="맡기기"');
  const button=html.match(new RegExp('<button[^>]*aria-label="'+label+'"[^>]*>'))![0];
  expect(button.includes('disabled=""')).toBe(false);
 });
 it("shows all linked sessions without a collapsed remaining count",()=>{
  seed();lookup.sessions=Array.from({length:5},(_,i)=>({agentSessionId:`s${i}`,callerSessionId:i?"s0":undefined,displayName:`세션 ${i}`,status:"completed",eventCount:2,createdAt:"2026-09-30",updatedAt:"2026-09-30"}));
  useCardStore.setState(s=>({details:{c:{...s.details.c,sessions:lookup.sessions.map(s=>({sessionId:s.agentSessionId})) as never}}}));
  const html=renderToStaticMarkup(<CardSessionHistory sessionIds={lookup.sessions.map(s=>s.agentSessionId)} onOpenSession={()=>{}}/>);expect(html.match(/data-session-id=/g)).toHaveLength(5);expect(html).not.toContain("2개 더");
 });
 it("previews the whole markdown report with only a three-line clamp",()=>{
  seed();useCardStore.setState(s=>({details:{c:{...s.details.c,reports:[{id:"paragraphs",sessionId:null,title:"문단 보고",format:"markdown",body:"첫 문단\n\n두 번째 문단\n\n세 번째 문단",createdAt:"2026-09-30"}]}}}));
  const html=render(),preview=html.split('data-report-id="paragraphs"')[1].split("<details>")[0];
  expect(preview).toContain('class="v3-card-three-lines"');
  expect(preview).toContain("첫 문단");expect(preview).toContain("두 번째 문단");expect(preview).toContain("세 번째 문단");
 });
 it("previews every HTML conclusion with only a three-line clamp",()=>{
  seed();useCardStore.setState(s=>({details:{c:{...s.details.c,reports:[{id:"html-paragraphs",sessionId:null,title:"HTML 보고",format:"html",body:"<style>.hidden { color: red; }</style><script>hiddenScript()</script><p>첫째 결론</p>\n\n<p>둘째 결론</p>",createdAt:"2026-09-30"}]}}}));
  const html=render(),preview=html.split('data-report-id="html-paragraphs"')[1].split("<details>")[0];
  expect(preview).toContain('class="v3-card-three-lines"');
  expect(preview).toContain("첫째 결론");expect(preview).toContain("둘째 결론");
  expect(preview).not.toContain("hiddenScript");expect(preview).not.toContain("color: red");
  expect(html).not.toContain('sandbox="allow-scripts"');
 });
 it("preserves attachment markdown conversion",()=>{
  expect(cardRequestMarkdown("첨부: 참고.png(https://example.test/file?path=png)")).toBe("첨부: ![참고.png](https://example.test/file?path=png)");
 });
 it("renders a read-only summary in the approved order and omits card actions",()=>{
  seed();
  const source={...useCardStore.getState().byId.c,number:31,title:"읽기 요약 제목",request:"요청 본문",
   attachments:[],now:{text:"현재 진행 상황",turn:"agent",ask:null,updatedAt:"2026-10-01T01:00:00Z",sessionId:"owner"},
   items:[{id:1,title:"확인 항목",state:"done",result:"사용자가 확인할 결과",evidence:[],caveat:null,rev:1,confirmed:{at:"2026-10-01",rev:1},fixOpen:0,reopened:null,from:null,createdAt:"2026-10-01",reportedAt:"2026-10-01",display:"reported"}]};
  const sample={...useCardStore.getState().details.c,card:source} as never;
  const html=renderToStaticMarkup(<CardDetailPane variant="summary" cardId="c" folders={[]} onClose={vi.fn()} onOpenSession={vi.fn()} onOpenCard={vi.fn()} sampleDetail={sample}/>);

  expect(html.indexOf("#31")).toBeLessThan(html.indexOf("읽기 요약 제목"));
  expect(html.indexOf("읽기 요약 제목")).toBeLessThan(html.indexOf("요청 본문"));
  expect(html.indexOf("요청 본문")).toBeLessThan(html.indexOf("현재 진행 상황"));
  expect(html.indexOf("현재 진행 상황")).toBeLessThan(html.indexOf("사용자가 확인할 결과"));
  expect(html).toContain('data-card-summary-section="request"');
  expect(html).toContain('data-card-summary-section="elapsed"');
  expect(html).not.toContain("어느 쪽?");
  expect(html).not.toContain("새 보고");
  expect(html).not.toContain("추가 지시");
  expect(html).not.toContain('role="tab"');
  expect(html).not.toContain("<textarea");
  expect(html).not.toContain("고칠 점 남기기");
  expect(html).not.toContain("실행 설정");
  expect(html).not.toContain("aria-label=\"카드 상태 변경\"");
  expect(html.match(/<button/g)).toHaveLength(1);
 });

 it("omits request, elapsed, and number when those fields have no data",()=>{
  seed();
  const source={...useCardStore.getState().byId.c,title:"번호 없는 오래된 카드",number:null,request:"",attachments:[],now:null,items:[]};
  const sample={...useCardStore.getState().details.c,card:source} as never;
  const html=renderToStaticMarkup(<CardDetailPane variant="summary" cardId="c" folders={[]} onClose={vi.fn()} onOpenSession={vi.fn()} onOpenCard={vi.fn()} sampleDetail={sample}/>);

  expect(html).toContain("번호 없는 오래된 카드");
  expect(html).not.toContain('data-card-summary-section="request"');
  expect(html).not.toContain('data-card-summary-section="elapsed"');
  expect(html).not.toContain("#null");
 });
});
