// packages/db-schema/scripts의 .mjs 모듈에는 선언 파일이 없다.
// 이 트리의 스크립트가 실제로 쓰는 export만 형으로 적어 ambient 모듈로 둔다.
// db-schema 패키지는 고치지 않는다.

declare module "*db-schema/scripts/migrate.mjs" {
  export function formatMigrationError(error: unknown, env?: NodeJS.ProcessEnv): string;
}

declare module "*db-schema/scripts/migration-contract.mjs" {
  export function readDatabaseUrl(env?: NodeJS.ProcessEnv): string;
  export function releaseServiceEnvironmentPath(env?: NodeJS.ProcessEnv, cwd?: string): string;
}
