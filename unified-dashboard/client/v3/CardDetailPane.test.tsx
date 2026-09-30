import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";
import { CardDetailPane, cardRequestMarkdown } from "./CardDetailPane";
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
const render=()=>renderToStaticMarkup(<CardDetailPane cardId="c" folders={[]} onClose={vi.fn()} onOpenSession={vi.fn()}/>);
describe("card final UX",()=>{
 it("orders request, questions, answer, reports and comments oldest first in shared chat bubbles",()=>{
  seed();const html=render();
  for(const text of ["지시","질문","답","보고","커멘트","대화에서","추가 지시"])expect(html).toContain(text);
  expect(html.match(/data-slot="chat-message-row"/g)).toHaveLength(6);
  expect(html.indexOf("옛 보고")).toBeLessThan(html.indexOf("새 보고"));
  expect(html).toContain('sandbox="allow-scripts"');
  expect(html).not.toContain('data-report-id="new" open');
  expect(html).toContain('aria-label="커멘트"');
  expect(html).not.toContain('aria-label="카드 섹션"');
  expect(html).toContain("그 밖에");
 });
 it.each(["review","running","todo","queued"])("has only one completion button, enabled only for review (%s)",status=>{
  seed(status);const html=render();
  expect(html).toMatch(/<button[^>]*aria-label="완료"/);
  expect(html).not.toContain('aria-label="반려"');expect(html).not.toContain('aria-label="맡기기"');
  const button=html.match(/<button[^>]*aria-label="완료"[^>]*>/)![0];
  expect(button.includes('disabled=""')).toBe(status!=="review");
 });
 it("shows the first three linked sessions and a remaining count using the folder tree",()=>{
  seed();lookup.sessions=Array.from({length:5},(_,i)=>({agentSessionId:`s${i}`,callerSessionId:i?"s0":undefined,displayName:`세션 ${i}`,status:"completed",eventCount:2,createdAt:"2026-09-30",updatedAt:"2026-09-30"}));
  useCardStore.setState(s=>({details:{c:{...s.details.c,sessions:lookup.sessions.map(s=>({sessionId:s.agentSessionId})) as never}}}));
  const html=render();expect(html.match(/data-session-id=/g)).toHaveLength(3);expect(html).toContain("2개 더");
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
  expect(html).toContain('sandbox="allow-scripts"');
 });
 it("preserves attachment markdown conversion",()=>{
  expect(cardRequestMarkdown("첨부: 참고.png(https://example.test/file?path=png)")).toBe("첨부: ![참고.png](https://example.test/file?path=png)");
 });
});
