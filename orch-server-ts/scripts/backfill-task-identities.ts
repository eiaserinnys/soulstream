import postgres from "postgres";

interface CandidateRow {
  task_id: string;
  candidate_page_ids: string[] | null;
}

const apply = process.argv.includes("--apply");
const databaseUrl = requiredEnv("DATABASE_URL");
const sql = postgres(databaseUrl, { max: 1 });

try {
  const rows = await sql<CandidateRow[]>`
    SELECT r.id AS task_id,
           COALESCE(
             array_agg(DISTINCT b.page_id) FILTER (WHERE b.page_id IS NOT NULL),
             ARRAY[]::TEXT[]
           ) AS candidate_page_ids
    FROM tasks r
    LEFT JOIN blocks b
      ON b.block_type = 'task_ref'
     AND b.properties->>'taskId' = r.id
     AND b.properties->>'primary' = 'true'
    WHERE r.task_page_id IS NULL
    GROUP BY r.id
    ORDER BY r.id
  `;
  const ambiguous = rows.filter((row) => (row.candidate_page_ids?.length ?? 0) > 1);
  process.stdout.write(`${JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    total: rows.length,
    reuseExistingPage: rows.filter((row) => row.candidate_page_ids?.length === 1).length,
    createPage: rows.filter((row) => (row.candidate_page_ids?.length ?? 0) === 0).length,
    ambiguous: ambiguous.map((row) => ({
      taskId: row.task_id,
      pageIds: row.candidate_page_ids,
    })),
  }, null, 2)}\n`);

  if (!apply) {
    process.stdout.write("Dry run only. Re-run with --apply after reviewing the report.\n");
  } else {
    if (ambiguous.length > 0) {
      throw new Error("ambiguous primary task_ref pages must be resolved before apply");
    }
    const orchBaseUrl = requiredEnv("ORCH_BASE_URL").replace(/\/$/, "");
    const authBearerToken = requiredEnv("AUTH_BEARER_TOKEN");
    for (const row of rows) {
      const pageId = row.candidate_page_ids?.[0];
      const response = await fetch(
        `${orchBaseUrl}/api/task-identities/host/backfill-legacy`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${authBearerToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            task_id: row.task_id,
            ...(pageId ? { page_id: pageId } : {}),
            actor_kind: "system",
            idempotency_key: `backfill-task-identity:${row.task_id}`,
            reason: "PR-AE task identity backfill",
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          `backfill failed for ${row.task_id}: ${response.status} ${await response.text()}`,
        );
      }
      const result = await response.json() as { taskId: string; pageId: string };
      process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
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
