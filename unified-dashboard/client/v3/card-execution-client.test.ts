import {afterEach,expect,it,vi} from "vitest";
import {executeCard} from "@seosoyoung/soul-ui/cards/card-execution";
import {reviewCard} from "./components-review-fixtures";
afterEach(()=>vi.unstubAllGlobals());
const response=(state:string)=>({ok:true,json:async()=>({card:reviewCard,execution:{state,requestId:"stable",sessionId:"owner"}})});
it("lost reply retains key/version and pending retries the same explicit request",async()=>{
 const fetch=vi.fn().mockRejectedValueOnce(new Error("lost")).mockResolvedValueOnce(response("pending")).mockResolvedValueOnce(response("started"));vi.stubGlobal("fetch",fetch);
 await expect(executeCard("lost-client",3)).rejects.toThrow("lost");
 expect((await executeCard("lost-client",4)).execution.state).toBe("pending");
 expect(fetch.mock.calls[0]![1].body).toBe(fetch.mock.calls[1]![1].body);
 await executeCard("lost-client",5);expect(fetch.mock.calls[2]![0]).toContain('/execute');expect(fetch.mock.calls[2]![1].body).toBe(fetch.mock.calls[0]![1].body);
});
it("two web surfaces share one outstanding write",async()=>{
 let finish!:(value:unknown)=>void;const fetch=vi.fn(()=>new Promise(done=>{finish=done;}));vi.stubGlobal("fetch",fetch);
 const results=[executeCard("concurrent-client",1),executeCard("concurrent-client",1)];
 expect(fetch).toHaveBeenCalledTimes(1);finish(response("already_running"));await Promise.all(results);
});
