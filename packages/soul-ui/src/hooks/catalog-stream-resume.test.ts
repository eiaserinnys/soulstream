/**
 * catalog-stream-resume 순수 함수 테스트.
 *
 * useSessionListProvider의 핵심 책임 셋을 hook 우회 없이 검증한다:
 *   1) buildCatalogStreamUrl — Last-Event-ID/instance_id 쿼리 부착, 빈 값 자동 제거
 *   2) reconcileStreamMeta — instance_id 변경 시 refetch 신호 + lastEventId 동기화
 *   3) reconcileReplayGap — 항상 refetch 신호 + lastEventId를 latest_id로 끌어올림
 */

import { describe, it, expect } from "vitest";
import {
  buildCatalogStreamUrl,
  reconcileReplayGap,
  reconcileStreamMeta,
} from "./catalog-stream-resume";

describe("buildCatalogStreamUrl", () => {
  it("lastEventId/instanceId가 모두 없으면 limit만 부착", () => {
    const url = buildCatalogStreamUrl();

    expect(url).toBe("/api/sessions/stream?limit=50");
  });

  it("lastEventId가 있으면 쿼리에 부착", () => {
    const url = buildCatalogStreamUrl("42");

    expect(url).toBe("/api/sessions/stream?limit=50&lastEventId=42");
  });

  it("instanceId가 있으면 쿼리에 부착", () => {
    const url = buildCatalogStreamUrl(undefined, "orch-A");

    expect(url).toBe("/api/sessions/stream?limit=50&instanceId=orch-A");
  });

  it("둘 다 있으면 모두 부착 (limit + lastEventId + instanceId)", () => {
    const url = buildCatalogStreamUrl("42", "orch-A");

    expect(url).toBe(
      "/api/sessions/stream?limit=50&lastEventId=42&instanceId=orch-A",
    );
  });

  it("빈 문자열은 falsy → 쿼리에 부착하지 않음 (NaN 오염 회피)", () => {
    const url = buildCatalogStreamUrl("", "");

    expect(url).toBe("/api/sessions/stream?limit=50");
  });
});

describe("reconcileStreamMeta", () => {
  it("instance_id가 비어있으면 null 반환 (noop)", () => {
    const result = reconcileStreamMeta(
      { type: "stream_meta", instance_id: "", latest_id: 10 },
      { instanceId: "orch-A", lastEventId: "5" },
    );

    expect(result).toBeNull();
  });

  it("첫 수신 (이전 instance_id 없음): refetch 없이 instance_id만 기록, lastEventId는 보존", () => {
    const result = reconcileStreamMeta(
      { type: "stream_meta", instance_id: "orch-A", latest_id: 100 },
      { instanceId: undefined, lastEventId: undefined },
    );

    expect(result).toEqual({
      nextInstanceId: "orch-A",
      nextLastEventId: undefined,
      shouldRefetch: false,
    });
  });

  it("instance_id 동일: refetch 없이 noop, lastEventId 기존값 보존", () => {
    const result = reconcileStreamMeta(
      { type: "stream_meta", instance_id: "orch-A", latest_id: 100 },
      { instanceId: "orch-A", lastEventId: "42" },
    );

    expect(result).toEqual({
      nextInstanceId: "orch-A",
      nextLastEventId: "42",
      shouldRefetch: false,
    });
  });

  it("instance_id 변경 (orch 재시작): refetch + lastEventId를 latest_id로 동기화", () => {
    const result = reconcileStreamMeta(
      { type: "stream_meta", instance_id: "orch-B", latest_id: 200 },
      { instanceId: "orch-A", lastEventId: "42" },
    );

    expect(result).toEqual({
      nextInstanceId: "orch-B",
      nextLastEventId: "200",
      shouldRefetch: true,
    });
  });

  it("instance_id 변경 + latest_id 0/누락: '0'으로 동기화 (NaN 회피)", () => {
    const result = reconcileStreamMeta(
      { type: "stream_meta", instance_id: "orch-B", latest_id: 0 },
      { instanceId: "orch-A", lastEventId: "42" },
    );

    expect(result?.nextLastEventId).toBe("0");
    expect(result?.shouldRefetch).toBe(true);
  });
});

describe("reconcileReplayGap", () => {
  it("항상 refetch + lastEventId를 latest_id로 끌어올림", () => {
    const result = reconcileReplayGap({
      type: "replay_gap",
      latest_id: 500,
      instance_id: "orch-A",
    });

    expect(result).toEqual({
      nextLastEventId: "500",
      shouldRefetch: true,
    });
  });

  it("latest_id 0/누락: '0'으로 동기화", () => {
    const result = reconcileReplayGap({
      type: "replay_gap",
      latest_id: 0 as never,
      instance_id: "orch-A",
    });

    expect(result.nextLastEventId).toBe("0");
    expect(result.shouldRefetch).toBe(true);
  });
});
