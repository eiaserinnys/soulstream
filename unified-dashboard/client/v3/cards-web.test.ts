import { afterEach, describe, expect, it, vi } from "vitest";
import { cardRequest, confirmCardItem, createCardInput, groupCards, queueAfterId } from "@seosoyoung/soul-ui/cards/card-api";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";

const card = <T extends Record<string, unknown> = Record<string, never>,>(id: string, status: string, extra: T = {} as T) => ({ id, folderId: "folder", title: id, status, version: 2, archived: false, ...extra });
afterEach(() => { vi.unstubAllGlobals(); useCardStore.getState().reset(); });
describe("card web contracts", () => {
  it("preserves the full request and uses the first line as title with selected execution fields", () => {
    expect(createCardInput("첫 요청\n둘째 요청", { folderId:"folder",nodeId:"node",agentId:"agent",modelPreset:"sol" }, "create-1"))
      .toEqual({ folderId:"folder", title:"첫 요청", request:"첫 요청\n둘째 요청", assignee:{kind:"agent",agentId:"agent"},nodeId:"node",modelPreset:"sol",queue:true,idempotencyKey:"create-1" });
    expect(createCardInput("가".repeat(90), {folderId:"f",nodeId:"n",agentId:"a",modelPreset:"m"},"k").title).toHaveLength(60);
  });
  it("includes every blocked kind and orders only queued cards by their server keys", () => {
    const grouped = groupCards([card("no", "blocked", {blockedKind:"no_report"}), card("limit", "blocked", {blockedKind:"limit"}), card("q", "blocked", {blockedKind:"question"}),card("rev","review"),card("b","queued",{queuePositionKey:"b"}),card("a","queued",{queuePositionKey:"a"}),card("run","running"),card("done","done")]);
    expect(grouped.attention.map(c=>c.id)).toEqual(["no","limit","q","rev"]);
    expect(grouped.queued.map(c=>c.id)).toEqual(["a","b"]);
    expect(grouped.running.map(c=>c.id)).toEqual(["run"]);
    expect(queueAfterId(["b","a"],"b")).toBeNull();
    expect(queueAfterId(["b","a"],"a")).toBe("b");
  });
  it.each([
    ["POST", "/api/cards", {folderId:"f",title:"T",request:"R",queue:true,idempotencyKey:"k"}],
    ["POST", "/api/cards/c/status", {status:"done",expectedVersion:2,idempotencyKey:"k"}],
    ["POST", "/api/cards/c/status", {status:"running",reason:"보완",expectedVersion:2,idempotencyKey:"k"}],
    ["POST", "/api/cards/c/status", {status:"queued",expectedVersion:2,idempotencyKey:"k"}],
    ["POST", "/api/cards/c/status", {status:"todo",expectedVersion:2,idempotencyKey:"k"}],
    ["POST", "/api/cards/c/status", {status:"cancelled",expectedVersion:2,idempotencyKey:"k"}],
    ["POST", "/api/cards/c/questions/q/answer", {answer:"선택",idempotencyKey:"k"}],
    ["POST", "/api/cards/c/queue-position", {afterCardId:null,expectedVersion:2,idempotencyKey:"k"}],
    ["POST", "/api/cards/c/move", {folderId:"other",expectedVersion:2,idempotencyKey:"k"}],
    ["PATCH", "/api/cards/c", {title:"새 제목",assignee:{kind:"agent",agentId:"a"},nodeId:"n",modelPreset:"m",expectedVersion:2,idempotencyKey:"k"}],
  ])("sends %s %s without legacy fields", async (method, path, body) => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({card:card("c","running")})));
    vi.stubGlobal("fetch",fetch);
    await cardRequest(path, method, body);
    expect(fetch).toHaveBeenCalledWith(path, expect.objectContaining({method, credentials:"same-origin", body:JSON.stringify(body)}));
  });
  it("keeps additive activity from folder lists and replaces it with authoritative mutation detail", async () => {
    const activity={kind:"instruction",format:"markdown",body:"목록 원문",createdAt:"2026-10-01T07:00:00Z"};
    const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({cards:[card("c","review",{latestActivity:activity})]})))
      .mockResolvedValueOnce(new Response(JSON.stringify({card:card("c","done")})))
      .mockResolvedValueOnce(new Response(JSON.stringify({card:card("c","done",{latestActivity:null}),reports:[],questions:[],sessions:[]})));
    vi.stubGlobal("fetch",fetch);
    await useCardStore.getState().loadFolder("folder");
    expect(useCardStore.getState().byId.c.latestActivity).toEqual(activity);
    await useCardStore.getState().mutate("c","/status",{status:"done",expectedVersion:2});
    expect(useCardStore.getState().byId.c.latestActivity).toBeNull();
    expect(fetch.mock.calls.map(call=>call[0])).toEqual(["/api/cards?folderId=folder","/api/cards/c/status","/api/cards/c"]);
  });
  it("refreshes only the card named by the wire event, including reports and questions", async () => {
    const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({card:card("changed","review",{latestActivity:{kind:"report",format:"html",body:"<p>신선한 보고</p>",createdAt:"2026-10-01T07:00:00Z"}}),reports:[{id:"r"}],questions:[{id:"q"}],sessions:[]})));
    vi.stubGlobal("fetch",fetch);
    useCardStore.setState({byId:{other:card("other","running") as never}});
    await useCardStore.getState().handleCardUpdated({cardId:"changed",folderId:"folder"});
    expect(fetch.mock.calls.map(c=>c[0])).toEqual(["/api/cards/changed"]);
    expect(useCardStore.getState().byId.other.status).toBe("running");
    expect(useCardStore.getState().byId.changed.status).toBe("review");
    expect(useCardStore.getState().byId.changed.latestActivity?.body).toBe("<p>신선한 보고</p>");
    expect(useCardStore.getState().details.changed.reports).toHaveLength(1);
  });
  it("confirms one item with the authoritative card response and no separate GET", async () => {
    const confirmedCard=card("c","running",{items:[{id:3,title:"확인",state:"done",result:"완료",evidence:[],caveat:null,rev:2,confirmed:{at:"2026-10-05T00:00:00Z",rev:2},fixOpen:0,reopened:null,from:null,createdAt:"2026-10-04T00:00:00Z",reportedAt:"2026-10-05T00:00:00Z",display:"confirmed"}]});
    const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({card:confirmedCard})));
    vi.stubGlobal("fetch",fetch);
    await expect(confirmCardItem("c",3,true)).resolves.toEqual({card:confirmedCard});
    expect(fetch.mock.calls.map(call=>call[0])).toEqual(["/api/cards/c/items/3/confirm"]);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({confirmed:true});
  });
});

describe("card item confirmation",()=>{
 const makeItem=(id:number,display:"todo"|"doing"|"confirmed")=>({id,title:`항목 ${id}`,state:display==="confirmed"?"done" as const:display,result:display==="confirmed"?"완료":null,evidence:[],caveat:null,rev:1,confirmed:display==="confirmed"?{at:"2026-10-05T00:00:00Z",rev:1}:null,fixOpen:0,reopened:null,from:null,createdAt:"2026-10-04T00:00:00Z",reportedAt:null,display});
 const setup=(items:ReturnType<typeof makeItem>[]=[makeItem(1,"todo"),makeItem(2,"doing")])=>{
  const current=card("c","running",{items});
  useCardStore.setState({byId:{c:current as never},details:{c:{card:current,reports:[],questions:[],sessions:[]} as never}});
  return current;
 };
 it("keeps confirmation intents per item when requests overlap and one fails",async()=>{
  const current=setup();let resolveFirst!:(response:Response)=>void,resolveSecond!:(response:Response)=>void;
  const fetch=vi.fn().mockImplementationOnce(()=>new Promise<Response>(resolve=>{resolveFirst=resolve;})).mockImplementationOnce(()=>new Promise<Response>(resolve=>{resolveSecond=resolve;}));vi.stubGlobal("fetch",fetch);
  const store=useCardStore.getState();
  const first=store.confirmItem("c",1,true),second=store.confirmItem("c",2,true);
  expect(useCardStore.getState().pendingItemConfirmations.c).toEqual({1:true,2:true});
  const confirmed={...current,items:[{...current.items![0],confirmed:{at:"2026-10-05T01:00:00Z",rev:1},display:"confirmed" as const},current.items![1]]};
  resolveFirst(new Response(JSON.stringify({card:confirmed})));await first;
  expect(useCardStore.getState().pendingItemConfirmations.c).toEqual({2:true});
  expect(useCardStore.getState().byId.c.items?.[0].display).toBe("confirmed");
  resolveSecond(new Response(JSON.stringify({message:"저장 실패"}),{status:500}));
  await expect(second).rejects.toThrow("저장 실패");
  expect(useCardStore.getState().pendingItemConfirmations.c).toBeUndefined();
  expect(useCardStore.getState().byId.c.items?.[0].display).toBe("confirmed");
  expect(useCardStore.getState().byId.c.items?.[1].display).toBe("doing");
 });
 it("sends a target comment with itemId then refreshes only that card",async()=>{
  const current=setup([makeItem(4,"doing")]);
  const saved={id:"saved-target",cardId:"c",authorKind:"user",authorId:"director",sessionId:null,kind:"comment",itemId:4,body:"고쳐주세요",createdAt:"2026-10-05T01:00:00Z"};
  const fixed={...current,items:[{...current.items![0],confirmed:null,fixOpen:1,display:"fix" as const}]};
  const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(saved))).mockResolvedValueOnce(new Response(JSON.stringify({card:fixed,reports:[],questions:[],sessions:[],comments:[saved]})));
  vi.stubGlobal("fetch",fetch);
  await useCardStore.getState().addComment("c","고쳐주세요","target-key",4);
  expect(fetch.mock.calls.map(call=>call[0])).toEqual(["/api/cards/c/comments","/api/cards/c"]);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({body:"고쳐주세요",idempotencyKey:"target-key",itemId:4});
  expect(useCardStore.getState().byId.c.items?.[0].display).toBe("fix");
  expect(useCardStore.getState().details.c.comments?.[0].itemId).toBe(4);
 });
});

describe("card comments",()=>{
 it("shows a new comment immediately, replaces it with the saved comment, then follows the wire detail",async()=>{
  const c=card("c","running");
  useCardStore.setState({details:{c:{card:c,reports:[],questions:[],sessions:[]} as never}});
  let finish!:(response:Response)=>void;
  const fetch=vi.fn().mockImplementationOnce(()=>new Promise<Response>(resolve=>{finish=resolve;}));vi.stubGlobal("fetch",fetch);
  const pending=useCardStore.getState().addComment("c","추가 지시","comment-key");
  expect(useCardStore.getState().details.c.comments?.map(comment=>comment.body)).toEqual(["추가 지시"]);
  const saved={id:"saved",cardId:"c",authorKind:"user",authorId:"director",sessionId:null,kind:"comment",body:"추가 지시",createdAt:"2026-09-30"};
  finish(new Response(JSON.stringify(saved)));await pending;
  expect(useCardStore.getState().details.c.comments).toEqual([saved]);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({body:"추가 지시",idempotencyKey:"comment-key"});
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({card:c,reports:[],questions:[],sessions:[],comments:[saved,{...saved,id:"next",authorKind:"agent",body:"반영하겠습니다"}]})));
  await useCardStore.getState().handleCardUpdated({cardId:"c",folderId:"folder"});
  expect(useCardStore.getState().details.c.comments).toHaveLength(2);
 });
 it("removes the optimistic comment and surfaces a real save failure",async()=>{
  useCardStore.setState({details:{c:{card:card("c","running"),reports:[],questions:[],sessions:[],comments:[]} as never}});
  vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new Error("저장 실패")));
  await expect(useCardStore.getState().addComment("c","지시","key")).rejects.toThrow("저장 실패");
  expect(useCardStore.getState().details.c.comments).toEqual([]);expect(useCardStore.getState().errors.c).toBe("저장 실패");
 });
});
