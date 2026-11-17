/**
 * exhaustiveList 타입 계약. vitest 수집 대상(*.test.ts)이 아닌 이름이라
 * soul-ui `typecheck`(tsc)만 이 파일을 검사한다.
 */
import { exhaustiveList } from "./exhaustive";

type Status = "todo" | "running" | "done";

// 모두 담으면 통과한다.
const allStatuses = exhaustiveList<Status>()(["todo", "running", "done"]);
export type AllStatuses = (typeof allStatuses)[number];

// 하나 빠지면 실패한다.
// @ts-expect-error - "done"이 빠졌다
exhaustiveList<Status>()(["todo", "running"]);

// 유니온 밖의 값이 들면 실패한다.
// @ts-expect-error - "cancelled"는 Status에 없다
exhaustiveList<Status>()(["todo", "running", "done", "cancelled"]);
