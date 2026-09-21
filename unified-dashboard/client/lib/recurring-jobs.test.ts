import { afterEach, describe, expect, it, vi } from "vitest";

import {
  archiveRecurringJob,
  createRecurringJob,
  listRecurringJobRuns,
  listRecurringJobs,
  previewRecurringSchedule,
  runRecurringJob,
  updateRecurringJob,
} from "./recurring-jobs";

describe("recurring job dashboard client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the authenticated public lifecycle contract, including escaped IDs", async () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
      new Response(JSON.stringify({ jobs: [], job: {}, run: {}, nextRuns: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchImplementation);
    const write = {
      name: "music recommendation",
      prompt: "use music-rec skill",
      timezone: "Asia/Seoul",
      schedule_expressions: ["0 9,12 * * 1-5"],
      node_id: "node-a",
      agent_id: "seosoyoung",
      model_preset: null,
      container: { kind: "folder" as const, id: "folder-a" },
      folder_id: "folder-a",
      late_run_window_seconds: 1_800,
      enabled: false,
    };

    await listRecurringJobs(true);
    await previewRecurringSchedule({
      timezone: write.timezone,
      schedule_expressions: write.schedule_expressions,
    });
    await createRecurringJob({ ...write, idempotency_key: "create-1" });
    await updateRecurringJob("job/1", { expected_version: 3, enabled: false });
    await runRecurringJob("job/1", "run-1");
    await archiveRecurringJob("job/1", 4);
    await listRecurringJobRuns("job/1");

    expect(fetchImplementation.mock.calls.map(([path]) => path)).toEqual([
      "/api/recurring-jobs?include_archived=true",
      "/api/recurring-jobs/preview",
      "/api/recurring-jobs",
      "/api/recurring-jobs/job%2F1",
      "/api/recurring-jobs/job%2F1/run",
      "/api/recurring-jobs/job%2F1/archive",
      "/api/recurring-jobs/job%2F1/runs?limit=50",
    ]);
    expect(JSON.parse(fetchImplementation.mock.calls[2]![1]?.body as string)).toEqual({
      ...write,
      idempotency_key: "create-1",
    });
    expect(JSON.parse(fetchImplementation.mock.calls[5]![1]?.body as string)).toEqual({
      expected_version: 4,
    });
    expect(fetchImplementation.mock.calls[6]![1]).toMatchObject({
      credentials: "same-origin",
      method: "GET",
    });
  });
});
