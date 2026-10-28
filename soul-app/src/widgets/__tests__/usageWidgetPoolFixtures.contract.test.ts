import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(root, `targets/usage-widget/fixtures/${name}.json`), 'utf8'));

test.each([
  ['single-account', 1, 1],
  ['multi-account', 2, 3],
  ['partially-blocked', 1, 2],
  ['all-blocked', 0, 2],
] as const)('widget %s fixture maps the Claude pool counts', (name, available, total) => {
  const summary = fixture(name);
  const claude = summary.nodes[0].providers.claude;
  expect(claude.pool).toMatchObject({ available_count: available, total_count: total });
  expect(claude.mode).toBe('pool');
});

test('legacy fixture omits pool fields and the Codable model keeps them optional', () => {
  const legacy = fixture('legacy');
  expect(legacy.nodes[0].providers.claude).not.toHaveProperty('mode');
  expect(legacy.nodes[0].providers.claude).not.toHaveProperty('pool');
  const models = fs.readFileSync(path.join(root, 'targets/usage-widget/UsageWidgetModels.swift'), 'utf8');
  expect(models).toContain('let mode: String?');
  expect(models).toContain('let pool: UsageSummaryClaudePool?');
  expect(models).toContain('let accounts: [UsageSummaryClaudeAccount]?');
  expect(models).toContain('case fablePool = "fable_pool"');
  expect(models).toContain('case authState = "auth_state"');
  expect(models).toContain('case fableWeekly = "fable_weekly"');
  expect(fixture('multi-account').nodes[0].providers.claude.accounts[0].usage.five_hour.used_percent).toBe(24);
});
