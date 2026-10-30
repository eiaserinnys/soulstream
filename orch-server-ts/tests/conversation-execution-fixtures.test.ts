import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { ExecutionRequest, Thread } from "../src/conversation/conversation_types.js";

it("reads the shared execution request and thread response fixtures", () => {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/conversation-v1/${name}.json`, import.meta.url), "utf8"));
  const request: ExecutionRequest = read("execution");
  const response: {thread: Thread} = read("thread");
  expect(request.expected_execution_id).toBe("execution-1");
  expect(request.profile).toBe("profile-a");
  expect(response.thread.execution_id).toBe("execution-2");
  expect(response.thread.profile).toEqual({id:"profile-a",label:"Profile A"});
});
