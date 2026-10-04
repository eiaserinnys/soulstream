import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {executeCard,cardExecutionState,resetCardExecutions} from "@seosoyoung/soul-ui/cards/card-execution";
import {reviewCard} from "./components-review-fixtures";
beforeEach(()=>vi.useFakeTimers());
afterEach(()=>{resetCardExecutions();vi.useRealTimers();vi.unstubAllGlobals();});
const response=(state:string)=>({ok:true,json:async()=>({card:reviewCard,execution:{state,requestId:"stable",sessionId:"owner"}})});
it("accepts pending then observes the same request by GET without another POST",async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(response("pending")).mockResolvedValue(response("started"));vi.stubGlobal("fetch",fetch);
 expect((await executeCard("pending-client",3)).execution.state).toBe("pending");
 expect(cardExecutionState("pending-client")?.phase).toBe("pending");
 await vi.advanceTimersByTimeAsync(1000);
 expect(fetch).toHaveBeenCalledTimes(2);expect(fetch.mock.calls[1]![0]).toContain('/execution?requestId=stable');expect(fetch.mock.calls[1]![1].method).toBe("GET");
 expect(cardExecutionState("pending-client")).toBeUndefined();
});
it("stops at thirty seconds and checks the same request again",async()=>{
 const fetch=vi.fn().mockResolvedValue(response("pending"));vi.stubGlobal("fetch",fetch);
 await executeCard("delayed-client",1);await vi.advanceTimersByTimeAsync(30000);
 expect(cardExecutionState("delayed-client")?.phase).toBe("delayed");
 const count=fetch.mock.calls.length;await vi.advanceTimersByTimeAsync(10000);expect(fetch).toHaveBeenCalledTimes(count);
 await executeCard("delayed-client",5);expect(fetch.mock.calls.at(-1)![1].method).toBe("GET");
});
it("reports a real failure and cancels observation on auth reset",async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(response("pending")).mockResolvedValue({ok:false,status:422,json:async()=>({message:"internal delivery/idempotency detail"})});vi.stubGlobal("fetch",fetch);
 await executeCard("failed-client",1);await vi.advanceTimersByTimeAsync(1000);
 expect(cardExecutionState("failed-client")).toMatchObject({phase:"error",message:"카드를 시작하지 못했습니다. 다시 시도해 주세요."});
 fetch.mockResolvedValue(response("pending"));await executeCard("auth-client",1);resetCardExecutions();
 const count=fetch.mock.calls.length;await vi.advanceTimersByTimeAsync(30000);expect(fetch).toHaveBeenCalledTimes(count);
});
it("two web surfaces share one outstanding write and preserve an already running owner",async()=>{
 let finish!:(value:unknown)=>void;const fetch=vi.fn(()=>new Promise(done=>{finish=done;}));vi.stubGlobal("fetch",fetch);
 const results=[executeCard("concurrent-client",1),executeCard("concurrent-client",1)];
 expect(fetch).toHaveBeenCalledTimes(1);finish(response("already_running"));
 const resolved=await Promise.all(results);expect(resolved[0].execution.sessionId).toBe("owner");expect(cardExecutionState("concurrent-client")).toBeUndefined();
});
