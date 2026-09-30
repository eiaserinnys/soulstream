import { afterEach, describe, expect, it, vi } from "vitest";
import { cardRequest, createCardInput, groupCards, queueAfterId } from "@seosoyoung/soul-ui/cards/card-api";
import { useCardStore } from "@seosoyoung/soul-ui/cards/card-store";

const card = (id: string, status: string, extra = {}) => ({ id, folderId: "folder", title: id, status, version: 2, archived: false, ...extra });
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
  it("refreshes only the card named by the wire event, including reports and questions", async () => {
    const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({card:card("changed","review"),reports:[{id:"r"}],questions:[{id:"q"}],sessions:[]})));
    vi.stubGlobal("fetch",fetch);
    useCardStore.setState({byId:{other:card("other","running") as never}});
    await useCardStore.getState().handleCardUpdated({cardId:"changed",folderId:"folder"});
    expect(fetch.mock.calls.map(c=>c[0])).toEqual(["/api/cards/changed"]);
    expect(useCardStore.getState().byId.other.status).toBe("running");
    expect(useCardStore.getState().byId.changed.status).toBe("review");
    expect(useCardStore.getState().details.changed.reports).toHaveLength(1);
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
