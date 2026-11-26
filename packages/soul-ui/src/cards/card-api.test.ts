import { afterEach, expect, it, vi } from "vitest";
import { CardApiError, cardRequest } from "./card-api";

afterEach(() => { vi.unstubAllGlobals(); });

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const json = (cards: string[]) => new Response(JSON.stringify({ cards }), { status: 200 });

it("카드 목록 읽기는 호출 뒤에 시작한 요청 하나로 합쳐지고 abort와 실패와 다른 URL은 따로 간다", async () => {
  const pending: { url: string; respond(response: Response): void }[] = [];
  const fetchMock = vi.fn((url: string) => new Promise<Response>(resolve => { pending.push({ url, respond: resolve }); }));
  vi.stubGlobal("fetch", fetchMock);

  const first = cardRequest<{ cards: string[] }>("/api/cards?includeCompleted=false");
  const sameTick = cardRequest<{ cards: string[] }>("/api/cards?includeCompleted=false");
  const folder = cardRequest<{ cards: string[] }>("/api/cards?includeCompleted=false&folderId=f1");
  await flush();
  expect(pending.map(request => request.url)).toEqual(["/api/cards?includeCompleted=false", "/api/cards?includeCompleted=false&folderId=f1"]);

  const late = cardRequest<{ cards: string[] }>("/api/cards?includeCompleted=false");
  const lateTwo = cardRequest<{ cards: string[] }>("/api/cards?includeCompleted=false");
  const aborter = new AbortController();
  const aborted = cardRequest<{ cards: string[] }>("/api/cards?includeCompleted=false", "GET", undefined, aborter.signal);
  const abortedResult = aborted.catch(error => error);
  aborter.abort();
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);

  pending[0].respond(json(["before-late"]));
  pending[1].respond(json(["folder"]));
  expect((await first).cards).toEqual(["before-late"]);
  expect(await sameTick).toEqual(await first);
  expect(await sameTick).not.toBe(await first);
  expect((await folder).cards).toEqual(["folder"]);
  expect(((await abortedResult) as Error).name).toBe("AbortError");
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(3);
  pending[2].respond(json(["after-start"]));
  expect((await late).cards).toEqual(["after-start"]);
  expect(await lateTwo).toEqual(await late);
  expect(await lateTwo).not.toBe(await late);

  const failing = [cardRequest("/api/cards"), cardRequest("/api/cards")].map(call => call.catch(error => error));
  await flush();
  pending[3].respond(new Response(JSON.stringify({ message: "서버 오류" }), { status: 500 }));
  const errors = await Promise.all(failing);
  expect(errors.every(error => error instanceof CardApiError && error.status === 500 && error.message === "서버 오류")).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(4);

  const writes = [cardRequest("/api/cards", "POST", { title: "a" }), cardRequest("/api/cards", "POST", { title: "a" })];
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(6);
  pending[4].respond(json(["w1"]));
  pending[5].respond(json(["w2"]));
  await Promise.all(writes);
});
