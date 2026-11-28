import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, FrameLoading, Input } from "@seosoyoung/soul-ui";
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
  const { t } = useTranslation();
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
      setMessage(t("jobs.dispatch.policySaved"));
    } catch (error) {
      if (error instanceof CardApiError && error.status === 409) {
        try {
          await load();
          setError(
            t("jobs.dispatch.policyConflict"),
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
      aria-label={t("jobs.dispatch.centralPolicy")}
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div>
        <h3 className="font-semibold">{t("jobs.dispatch.centralTitle")}</h3>
        <p className="text-muted-foreground">
          {t("jobs.dispatch.centralHelp")}
        </p>
      </div>
      {!policy ? (
        <FrameLoading inline label={t("jobs.common.loading")} />
      ) : (
        <>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => setPolicy({ ...policy, enabled: !policy.enabled })}
          >
            {policy.enabled ? t("jobs.dispatch.disableAutomatic") : t("jobs.dispatch.enableAutomatic")}
          </Button>
          <p className="text-muted-foreground">
            {t("jobs.dispatch.usageFreshness")}
          </p>
          {policy.candidates.map((item, index) => (
            <fieldset key={index} className="space-y-4" disabled={pending}>
              <legend className="font-semibold">{t("jobs.dispatch.priority", { priority: index + 1 })}</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-2">
                  <span>{t("jobs.dispatch.agentProfile")}</span>
                  <Input
                    disabled={pending}
                    aria-label={t("jobs.dispatch.priorityAgent", { priority: index + 1 })}
                    value={item.agentId}
                    onChange={(event) =>
                      candidate(index, { agentId: event.target.value })
                    }
                  />
                </label>
                <label className="space-y-2">
                  <span>{t("jobs.dispatch.modelPreset")}</span>
                  <Input
                    disabled={pending}
                    aria-label={t("jobs.dispatch.priorityPreset", { priority: index + 1 })}
                    value={item.modelPreset}
                    onChange={(event) =>
                      candidate(index, { modelPreset: event.target.value })
                    }
                  />
                </label>
                <label className="space-y-2">
                  <span>{t("jobs.dispatch.executionNode")}</span>
                  <Input
                    disabled={pending}
                    aria-label={t("jobs.dispatch.priorityNode", { priority: index + 1 })}
                    value={item.nodeId}
                    onChange={(event) =>
                      candidate(index, { nodeId: event.target.value })
                    }
                  />
                </label>
                <label className="space-y-2">
                  <span>{t("jobs.dispatch.minRemaining")}</span>
                  <Input
                    disabled={pending}
                    aria-label={t("jobs.dispatch.priorityMinRemaining", { priority: index + 1 })}
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
                  {t("jobs.dispatch.movePriorityUp", { priority: index + 1 })}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending || index === policy.candidates.length - 1}
                  onClick={() => move(index, 1)}
                >
                  {t("jobs.dispatch.movePriorityDown", { priority: index + 1 })}
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
                  {t("jobs.dispatch.removePriority", { priority: index + 1 })}
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
            {t("jobs.dispatch.addCandidate")}
          </Button>
          <div className="space-y-4">
            <label className="block space-y-2">
              <span>{t("jobs.dispatch.archiveFolderOptional")}</span>
              <Input
                disabled={pending}
                aria-label={t("jobs.dispatch.archiveFolder")}
                placeholder={t("jobs.dispatch.archiveFolderPlaceholder")}
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
              <span>{t("jobs.dispatch.parentFolderOptional")}</span>
              <Input
                disabled={pending}
                aria-label={t("jobs.dispatch.parentFolder")}
                placeholder={t("jobs.dispatch.parentFolderPlaceholder")}
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
            {t("jobs.dispatch.archiveFolderHelp")}
          </p>
        </>
      )}
      {payload ? (
        <p className="text-muted-foreground">
          {t("jobs.dispatch.policyVersion", { version: payload.settings.version, state: payload.status?.state ? ` · ${payload.status.state}` : "", reason: payload.status?.reason ? ` · ${payload.status.reason}` : "" })}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive-foreground">
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
          {t("jobs.dispatch.reloadPolicy")}
        </Button>
        <Button type="submit" disabled={!changed || pending}>
          {pending ? t("jobs.dispatch.savingPolicy") : t("jobs.dispatch.savePolicy")}
        </Button>
      </div>
    </form>
  );
}
