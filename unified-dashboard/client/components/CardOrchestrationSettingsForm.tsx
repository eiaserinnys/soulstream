import { useEffect, useState } from "react";
import { Button, Input } from "@seosoyoung/soul-ui";
import { CardApiError, cardRequest } from "@seosoyoung/soul-ui/cards/card-api";
import {
  parseOrchestrationPolicy,
  type OrchestrationPolicy,
  type OrchestrationSettings,
  type OrchestrationCandidate,
} from "../../../packages/wire-schema/src/card_orchestration";
const endpoint = "/api/settings/card-orchestration";
export type CardOrchestrationSettingsPayload = {
  settings: OrchestrationSettings;
  status?: { state?: string; reason?: string | null };
};
/** Uses the same Input/Button and spacing as the existing card execution settings. */
export interface CardOrchestrationSettingsService {
  read(): Promise<CardOrchestrationSettingsPayload>;
  write(input: {
    expectedVersion: number;
    policy: OrchestrationPolicy;
  }): Promise<CardOrchestrationSettingsPayload>;
}
const defaultService: CardOrchestrationSettingsService = {
  read: () => cardRequest(endpoint),
  write: (input) => cardRequest(endpoint, "PUT", input),
};
export function CardOrchestrationSettingsForm({
  service = defaultService,
}: { service?: CardOrchestrationSettingsService } = {}) {
  const [payload, setPayload] =
      useState<CardOrchestrationSettingsPayload | null>(null),
    [policy, setPolicy] = useState<OrchestrationPolicy | null>(null);
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null),
    [message, setMessage] = useState<string | null>(null);
  async function load() {
    const next = await service.read();
    setPayload(next);
    setPolicy(next.settings.policy);
  }
  useEffect(() => {
    void load().catch((error) => setError(String(error)));
  }, [service]);
  const changed =
    policy !== null &&
    payload !== null &&
    JSON.stringify(policy) !== JSON.stringify(payload.settings.policy);
  function candidate(index: number, patch: Partial<OrchestrationCandidate>) {
    setPolicy((current) =>
      current
        ? {
            ...current,
            candidates: current.candidates.map((item, i) =>
              i === index ? { ...item, ...patch } : item,
            ),
          }
        : current,
    );
    setMessage(null);
  }
  function move(index: number, delta: number) {
    setPolicy((current) => {
      if (!current) return current;
      const candidates = [...current.candidates];
      [candidates[index], candidates[index + delta]] = [
        candidates[index + delta]!,
        candidates[index]!,
      ];
      return { ...current, candidates };
    });
  }
  async function save() {
    if (!policy || !payload || pending) return;
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const next = await service.write({
        expectedVersion: payload.settings.version,
        policy: parseOrchestrationPolicy(policy),
      });
      setPayload(next);
      setPolicy(next.settings.policy);
      setMessage("배정 정책을 저장했습니다.");
    } catch (error) {
      if (error instanceof CardApiError && error.status === 409) {
        try {
          await load();
          setError(
            "설정이 바뀌어 최신 정책을 불러왔습니다. 확인 후 다시 저장하세요.",
          );
        } catch (cause) {
          setError(String(cause));
        }
      } else setError(String(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <form
      className="space-y-4"
      aria-label="중앙 카드 배정 정책"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div>
        <h3 className="font-semibold">중앙 카드 배정</h3>
        <p className="text-muted-foreground">
          조건을 만족하는 첫 모델이 대기 카드의 배정 순서를 판단합니다. 실제
          작업자의 모델은 카드 설정을 따릅니다.
        </p>
      </div>
      {!policy ? (
        <p>불러오는 중…</p>
      ) : (
        <>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => setPolicy({ ...policy, enabled: !policy.enabled })}
          >
            {policy.enabled ? "자동 배정 끄기" : "자동 배정 켜기"}
          </Button>
          <p className="text-muted-foreground">
            사용량은 원천 관측 후 5분 이내인 값만 사용합니다. 한도 리셋 뒤 새
            사용량을 확인하면 배정을 다시 시작합니다.
          </p>
          {policy.candidates.map((item, index) => (
            <fieldset key={index} className="space-y-4" disabled={pending}>
              <legend className="font-semibold">{index + 1}순위</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-2">
                  <span>에이전트 프로필</span>
                  <Input
                    disabled={pending}
                    aria-label={`${index + 1}순위 에이전트 프로필`}
                    value={item.agentId}
                    onChange={(event) =>
                      candidate(index, { agentId: event.target.value })
                    }
                  />
                </label>
                <label className="space-y-2">
                  <span>모델 프리셋</span>
                  <Input
                    disabled={pending}
                    aria-label={`${index + 1}순위 모델 프리셋`}
                    value={item.modelPreset}
                    onChange={(event) =>
                      candidate(index, { modelPreset: event.target.value })
                    }
                  />
                </label>
                <label className="space-y-2">
                  <span>실행 노드</span>
                  <Input
                    disabled={pending}
                    aria-label={`${index + 1}순위 실행 노드`}
                    value={item.nodeId}
                    onChange={(event) =>
                      candidate(index, { nodeId: event.target.value })
                    }
                  />
                </label>
                <label className="space-y-2">
                  <span>최소 잔여 사용량 (%)</span>
                  <Input
                    disabled={pending}
                    aria-label={`${index + 1}순위 최소 잔여 사용량`}
                    type="number"
                    min={0}
                    max={100}
                    value={item.minimumRemainingPercent}
                    onChange={(event) =>
                      candidate(index, {
                        minimumRemainingPercent: Number(event.target.value),
                      })
                    }
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending || index === 0}
                  onClick={() => move(index, -1)}
                >
                  {index + 1}순위 위로
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending || index === policy.candidates.length - 1}
                  onClick={() => move(index, 1)}
                >
                  {index + 1}순위 아래로
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    setPolicy({
                      ...policy,
                      candidates: policy.candidates.filter(
                        (_, i) => i !== index,
                      ),
                    })
                  }
                >
                  {index + 1}순위 제거
                </Button>
              </div>
            </fieldset>
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() =>
              setPolicy({
                ...policy,
                candidates: [
                  ...policy.candidates,
                  {
                    agentId: "",
                    nodeId: "",
                    modelPreset: "",
                    minimumRemainingPercent: 15,
                  },
                ],
              })
            }
          >
            모델 후보 추가
          </Button>
          <div className="space-y-4">
            <label className="block space-y-2">
              <span>판단 세션 보관 폴더 (선택)</span>
              <Input
                disabled={pending}
                aria-label="판단 세션 보관 폴더"
                placeholder="비우면 첫 판단 때 전용 폴더를 만듭니다"
                value={policy.sessionFolderId ?? ""}
                onChange={(event) =>
                  setPolicy({
                    ...policy,
                    sessionFolderId: event.target.value || null,
                  })
                }
              />
            </label>
            <label className="block space-y-2">
              <span>새 보관 폴더의 상위 폴더 (선택)</span>
              <Input
                disabled={pending}
                aria-label="새 보관 폴더의 상위 폴더"
                placeholder="비우면 최상위에 만듭니다"
                value={policy.systemFolderParentId ?? ""}
                onChange={(event) =>
                  setPolicy({
                    ...policy,
                    systemFolderParentId: event.target.value || null,
                  })
                }
              />
            </label>
          </div>
          <p className="text-muted-foreground">
            폴더를 지정하면 삭제·보관·접근 제한 시 자동으로 다른 폴더로 바꾸지
            않습니다.
          </p>
        </>
      )}
      {payload ? (
        <p className="text-muted-foreground">
          정책 v{payload.settings.version}
          {payload.status?.state ? ` · ${payload.status.state}` : ""}
          {payload.status?.reason ? ` · ${payload.status.reason}` : ""}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-accent-red">
          {error}
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => {
            setError(null);
            void load().catch((error) => setError(String(error)));
          }}
        >
          배정 정책 다시 불러오기
        </Button>
        <Button type="submit" disabled={!changed || pending}>
          {pending ? "배정 정책 저장 중…" : "배정 정책 저장"}
        </Button>
      </div>
    </form>
  );
}
