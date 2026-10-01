import { useMemo } from "react";
import {
  CardOrchestrationSettingsForm,
  type CardOrchestrationSettingsPayload,
  type CardOrchestrationSettingsService,
} from "../components/CardOrchestrationSettingsForm";
/** Actual settings implementation; this service only changes the review sample. */
export function CardOrchestrationSettingsSample() {
  const service = useMemo<CardOrchestrationSettingsService>(() => {
    let value: CardOrchestrationSettingsPayload = {
      settings: {
        key: "card_orchestration",
        version: 1,
        updatedAt: "2026-10-01T00:00:00.000Z",
        updatedBy: "검수 샘플",
        policy: {
          enabled: false,
          candidates: [
            {
              agentId: "ariella-orchestrator",
              nodeId: "eiaserinnys",
              modelPreset: "claude-opus",
              minimumRemainingPercent: 15,
            },
            {
              agentId: "ariella-orchestrator",
              nodeId: "eiaserinnys",
              modelPreset: "codex-6-astra",
              minimumRemainingPercent: 15,
            },
          ],
          usageMaxAgeMs: 300000,
          sessionFolderId: null,
          systemFolderParentId: null,
        },
      },
      status: {
        state: "대기",
        reason: "검수 샘플은 작업을 배정하지 않습니다.",
      },
    };
    return {
      read: async () => structuredClone(value),
      write: async (input) => {
        value = {
          ...value,
          settings: {
            ...value.settings,
            policy: input.policy,
            version: input.expectedVersion + 1,
          },
        };
        return structuredClone(value);
      },
    };
  }, []);
  return <CardOrchestrationSettingsForm service={service} />;
}
