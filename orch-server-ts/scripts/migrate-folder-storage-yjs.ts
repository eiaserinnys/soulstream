import { runFolderStorageMigration } from "../src/folders/folder_storage_migration_cli.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.includes("test")) {
  throw new Error("TEST_DATABASE_URL must name a dedicated test database");
}
console.log(JSON.stringify(await runFolderStorageMigration(databaseUrl)));
