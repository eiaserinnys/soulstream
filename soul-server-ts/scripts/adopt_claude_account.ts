import { adoptClaudeAccountProfile } from "../src/claude_accounts/adopt.js";

async function main(): Promise<void> {
  const profilePath = process.argv[2]?.trim();
  if (!profilePath) {
    console.error("Usage: pnpm --dir soul-server-ts claude-accounts:adopt <profiles/<UUID> path>");
    process.exitCode = 1;
    return;
  }

  const accountsDir = process.env.CLAUDE_ACCOUNTS_DIR?.trim() || undefined;
  const record = await adoptClaudeAccountProfile({
    profilePath,
    accountsDir,
  });

  console.log(
    JSON.stringify(
      {
        adopted: true,
        account: record,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
