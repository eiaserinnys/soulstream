import { test, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadNodeSqlite } from '../../src/runner/node_sqlite.js';
import { installDiagnosticHooks, captureDiagnosticSnapshot } from './diagnostic_hooks.js';

test('collector imports, reads and closes temporary SQLite and persists diagnostics', async () => {
  expect(process.env.DATABASE_URL).toBeUndefined();
  expect(process.env.TEST_DATABASE_URL).toBeUndefined();
  expect(process.env.AUTH_BEARER_TOKEN).toBeUndefined();
  const output = process.env.RUNNER_DIAGNOSTIC_DIR!;
  expect(output).toBeTruthy();
  const root = mkdtempSync(join(tmpdir(), 'collector-sqlite-smoke-'));
  const { DatabaseSync } = loadNodeSqlite();
  let closes = 0;
  const originalClose = DatabaseSync.prototype.close;
  DatabaseSync.prototype.close = function () { closes++; return originalClose.call(this); };
  try {
    const db = new DatabaseSync(join(root, 'temporary.sqlite'));
    try { db.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES ('smoke-only')"); }
    finally { db.close(); }
    installDiagnosticHooks();
    const fakeSql = { unsafe: async (query: string) => {
      expect(query).toMatch(/^SELECT to_jsonb\(r\) AS row FROM [a-z_]+ r LIMIT 200$/);
      return [];
    }};
    await captureDiagnosticSnapshot(root, fakeSql, 'smoke');
    const snapshot = JSON.parse(readFileSync(join(output, 'smoke.json'), 'utf8'));
    expect(snapshot.errors).toEqual([]);
    expect(snapshot.files.every((f: any) => !f.error)).toBe(true);
    expect(snapshot.files.find((f: any) => f.path === 'temporary.sqlite').sqlite.probe.rows).toEqual([{ value: 'smoke-only' }]);
    expect(snapshot.files.find((f: any) => f.path === 'temporary.sqlite').sqlite.probe.count).toEqual({ count: 1 });
    expect(Object.values(snapshot.postgres).every(v => Array.isArray(v))).toBe(true);
    expect(closes).toBe(2);
    const stages = readdirSync(output).filter(n => /^stages-.*\.jsonl$/.test(n)).flatMap(n => readFileSync(join(output, n), 'utf8').trim().split('\n').map(JSON.parse));
    expect(stages.some(r => r.stage === 'hooks_installed')).toBe(true);
    expect(stages.some(r => r.stage === 'snapshot.resolved' && r.phase === 'smoke')).toBe(true);
    expect(stages.some(r => r.stage === 'hook_missing' || r.stage === 'snapshot.write_failed')).toBe(false);
  } finally {
    DatabaseSync.prototype.close = originalClose;
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
