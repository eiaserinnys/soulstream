import postgres from "postgres";

import { planFolderProjectBackfill } from "../src/folders/folder_project_backfill_plan.js";

const apply = process.argv.includes("--apply");
const databaseUrl = requiredEnv("DATABASE_URL");
const sql = postgres(databaseUrl, { max: 1 });

try {
  const folders = await sql<Array<{ id: string; name: string }>>`
    SELECT id, name FROM folders
    WHERE project_page_id IS NULL AND archived = FALSE
      AND id NOT IN ('claude', 'llm')
    ORDER BY sort_order, name, id
  `;
  const pages = await sql<Array<{
    id: string;
    title: string;
    daily: boolean;
    task_identity: boolean;
    bound_folder_id: string | null;
  }>>`
    SELECT p.id, p.title,
           p.daily_date IS NOT NULL AS daily,
           EXISTS(SELECT 1 FROM tasks r WHERE r.task_page_id = p.id) AS task_identity,
           (SELECT f.id FROM folders f WHERE f.project_page_id = p.id LIMIT 1) AS bound_folder_id
    FROM pages p
    WHERE p.archived = FALSE
    ORDER BY p.title, p.id
  `;
  const plan = planFolderProjectBackfill(folders, pages.map((page) => ({
    id: page.id,
    title: page.title,
    daily: page.daily,
    taskIdentity: page.task_identity,
    boundFolderId: page.bound_folder_id,
  })));
  process.stdout.write(`${JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    total: folders.length,
    reuseExistingPage: plan.reuse.length,
    createPage: plan.create.length,
    ambiguous: plan.ambiguous,
    reuse: plan.reuse,
    create: plan.create,
  }, null, 2)}\n`);

  if (!apply) {
    process.stdout.write("Dry run only. Re-run with --apply only after explicit approval.\n");
  } else {
    if (plan.ambiguous.length > 0) {
      throw new Error("ambiguous project pages must be resolved before apply");
    }
    const orchBaseUrl = requiredEnv("ORCH_BASE_URL").replace(/\/$/, "");
    const authBearerToken = requiredEnv("AUTH_BEARER_TOKEN");
    for (const entry of [...plan.reuse, ...plan.create]) {
      const existing = "disposition" in entry;
      const response = await fetch(
        `${orchBaseUrl}/api/folder-project-identities/host/backfill-legacy`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${authBearerToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            folder_id: entry.folderId,
            ...(existing ? { page_id: entry.pageId } : {}),
            actor_kind: "system",
            idempotency_key: `backfill-folder-project:${entry.folderId}`,
            reason: "PR-AF folder project identity backfill",
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          `backfill failed for ${entry.folderId}: ${response.status} ${await response.text()}`,
        );
      }
      process.stdout.write(`${JSON.stringify({ ok: true, folderId: entry.folderId })}\n`);
    }
  }
} finally {
  await sql.end();
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
