import type { CoordinatorOptions } from "./card_orchestration_coordinator.js";
import type { WorkerDispatch } from "./card_orchestration_repository.js";
import type { CardLaunch } from "./card_dispatcher.js";
/** Durable worker intent owns launch/recovery independently of the model decision lifecycle. */
export class CardOrchestrationWorkers {
  constructor(
    private readonly options: Pick<
      CoordinatorOptions,
      "repository" | "cards" | "launchWorker" | "sendMessage" | "warn"
    >,
  ) {}
  async reconcile() {
    for (const d of await this.options.repository.pendingWorkers()) {
      if (d.state === "launching") {
        if (await this.options.repository.workerObserved(d.session_id,d.run_id,d.card_id))
          await this.options.repository.workerState(d.session_id, "running");
        else if (d.expired) {
          if (!d.launch_accepted)
            await this.reject(
              d,
              "Worker launch was never accepted before its deadline",
            );
          else
            await this.options.repository.note(
              "blocked",
              "worker_launch_accepted_observation_pending",
            );
        }
        continue;
      }
      if (!(await this.options.repository.claimWorker(d.session_id))) continue;
      const admission = {
        runId: d.run_id,
        executionToken: d.launch_token,
        cardId: d.card_id,
        ...(d.input.deliveryId ? {deliveryId:String(d.input.deliveryId)} : {}),
      };
      try {
        if (d.input.existingSession === true || d.input.resume === true) {
          const text=String(d.input.prompt ?? "한도가 풀려 재개한다. 첫 행동은 WIP 커밋이다. 이어서 카드 규칙대로 진행한다.");
          const attachments=d.input.attachments as import("@soulstream/wire-schema/card-attachments").CardAttachment[] | undefined;
          if(attachments?.length) await this.options.sendMessage(d.session_id,text,admission,undefined,attachments);
          else await this.options.sendMessage(d.session_id,text,admission);
        }
        else
          await this.options.launchWorker({
            ...d.input,
            orchestrationAdmission: admission,
          } as unknown as CardLaunch);
        if (await this.options.repository.workerObserved(d.session_id,d.run_id,d.card_id))
          await this.options.repository.workerState(d.session_id, "running");
      } catch (error) {
        if ((error as { code?: string }).code === "NODE_REJECTED")
          await this.reject(d, String(error));
        else
          this.options.warn(
            `worker launch awaiting observation: ${String(error)}`,
          );
      }
    }
  }
  private async reject(d: WorkerDispatch, reason: string) {
    const cards = await this.options.cards(),
      detail = await cards.getCard(d.card_id);
    if (detail && ["running","queued"].includes(detail.card.status))
      await cards.setCardStatus({
        actorKind: "system",
        actorSessionId: null,
        cardId: d.card_id,
        expectedVersion: detail.card.version,
        status: "blocked",
        blockedKind: "no_report",
        blockedDetail: reason,
      });
    await this.options.repository.workerState(d.session_id, "rejected", reason);
  }
}
