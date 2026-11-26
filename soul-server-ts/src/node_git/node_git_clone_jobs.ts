import { randomUUID } from "node:crypto";

import type { NodeGitCloneJob, NodeGitError } from "@soulstream/wire-schema";

const RETAINED_FINISHED_JOBS = 5;

/** 노드 메모리에만 두는 클론 작업. 동시에 하나만 돌고, 끝난 작업은 최근 5개만 남긴다. */
export class NodeGitCloneJobs {
  private readonly jobs = new Map<string, NodeGitCloneJob>();

  running(): NodeGitCloneJob | undefined {
    return [...this.jobs.values()].find((job) => job.state === "running");
  }

  latest(): NodeGitCloneJob | null {
    return this.running() ?? [...this.jobs.values()].at(-1) ?? null;
  }

  get(cloneId: string): NodeGitCloneJob | undefined {
    return this.jobs.get(cloneId);
  }

  start(input: { repoName: string; url: string }): NodeGitCloneJob {
    const job: NodeGitCloneJob = {
      clone_id: randomUUID(),
      repo_name: input.repoName,
      url: input.url,
      state: "running",
      error: null,
      started_at: new Date().toISOString(),
      finished_at: null,
    };
    this.jobs.set(job.clone_id, job);
    return job;
  }

  finish(cloneId: string, error: NodeGitError | null): void {
    const job = this.jobs.get(cloneId);
    if (!job) return;
    this.jobs.set(cloneId, {
      ...job,
      state: error === null ? "done" : "failed",
      error,
      finished_at: new Date().toISOString(),
    });
    const finished = [...this.jobs.values()].filter((item) => item.state !== "running");
    for (const stale of finished.slice(0, Math.max(0, finished.length - RETAINED_FINISHED_JOBS))) {
      this.jobs.delete(stale.clone_id);
    }
  }
}
