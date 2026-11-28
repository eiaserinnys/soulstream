// Integrity checks for the public atom seed.
//
// The seed and the two portraits are published byte-for-byte as reviewed; the
// sha256 comparison in the unit's verify step owns the byte-identity check.
// This file checks the seed's internal contract:
// shape, ordering, placeholders, link blocks, forbidden patterns, profile
// arguments and the portrait files.
//
// Link block rules are transcribed from the load_skill parser:
//   orch-server-ts/src/mcp/skill_handlers.ts (load_skill)
//   orch-server-ts/src/skills/link_blocks.ts:56-152 (fence scan + field rules)
// The TypeScript parser cannot be imported from a plain node:test file, so the
// fence grammar and field rules are re-implemented below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildCreatePayload, placeholderKeys, validateSeed } from '../seed/load_atom_seed.mjs';

import { readInstallerText } from '../seed/locales/installer-text.mjs';
import { completeLanguages } from '../seed/locales/languages.mjs';
import { readLocalizedSeed } from '../seed/locales/seed.mjs';
import { forbiddenSeedText } from '../seed/locales/text.mjs';
import { compareLinkBlocks, extractLinkBlocks, parseLinkBlockBody } from './support/seed_link_blocks.mjs';

const SEED_PATH = fileURLToPath(new URL('../seed/atom-seed.json', import.meta.url));
const PORTRAIT_PATHS = {
  seosoyoung: fileURLToPath(new URL('../assets/portraits/seosoyoung.png', import.meta.url)),
  'seosoyoung-pas': fileURLToPath(new URL('../assets/portraits/seosoyoung-pas.png', import.meta.url)),
};

const SEED = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
const CARDS = SEED.entries.filter((entry) => entry.entry_kind === 'card');
const SYMLINKS = SEED.entries.filter((entry) => entry.entry_kind === 'symlink');
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;

function seedTexts(seed) {
  const rows = [];
  for (const entry of seed.entries) {
    rows.push([`title:${entry.key}`, entry.title ?? '']);
    rows.push([`content:${entry.key}`, entry.content ?? '']);
  }
  for (const [name, key] of Object.entries(seed.exported_keys)) {
    rows.push([`exported:${name}`, String(key)]);
  }
  return rows;
}

test('seed shape: schema, entry counts, exported keys, roots', () => {
  assert.equal(SEED.schema_version, 1);
  assert.equal(SEED.entries.length, 210);
  assert.equal(CARDS.length, 172);
  assert.equal(SYMLINKS.length, 38);
  assert.equal(Object.keys(SEED.exported_keys).length, 20);
  const roots = SEED.entries.filter((entry) => (entry.parent ?? null) === null).map((entry) => entry.title);
  assert.deepEqual(roots, ['에이전트', '프로젝트', '실수 사례']);
});

test('validateSeed accepts the approved seed and rejects contract violations', () => {
  assert.doesNotThrow(() => validateSeed(SEED));
  const clone = () => structuredClone(SEED);
  const duplicate = clone();
  duplicate.entries.push(structuredClone(CARDS[0]));
  assert.throws(() => validateSeed(duplicate), /duplicate seed key/);

  const badKind = clone();
  badKind.entries.find((entry) => entry.entry_kind === 'card').entry_kind = 'folder';
  assert.throws(() => validateSeed(badKind), /invalid entry_kind/);

  const laterParent = clone();
  laterParent.entries.push({ key: 'zz.late.child', title: 'late', card_type: 'knowledge', parent: 'zz.not.yet', entry_kind: 'card', content: '' });
  assert.throws(() => validateSeed(laterParent), /not a preceding card/);

  const badTarget = clone();
  badTarget.entries.find((entry) => entry.entry_kind === 'symlink').symlink_target = 'no.such.card';
  assert.throws(() => validateSeed(badTarget), /targets a non-card key/);

  const symlinkKey = SYMLINKS[0].key;
  const badPlaceholder = clone();
  badPlaceholder.entries.find((entry) => entry.entry_kind === 'card').content = `{{node_id:${symlinkKey}}}`;
  assert.throws(() => validateSeed(badPlaceholder), /non-card key/);

  const badExport = clone();
  badExport.exported_keys = { ...badExport.exported_keys, broken: 'no.such.key' };
  assert.throws(() => validateSeed(badExport), /does not exist/);
});

test('buildCreatePayload: 172 creates, seed order, positions, body under the Fastify limit', () => {
  const installId = '00000000-0000-4000-8000-000000000000';
  const payload = buildCreatePayload(SEED, installId);
  assert.equal(payload.creates.length, 172);
  assert.deepEqual(payload.creates.map((item) => item.temp_id), CARDS.map((entry) => entry.key));
  const size = Buffer.byteLength(JSON.stringify(payload));
  assert.ok(size < 1_048_576, `batch body is ${size} bytes`);

  const counters = new Map();
  for (const entry of SEED.entries) {
    const parent = entry.parent ?? null;
    const index = counters.get(parent) ?? 0;
    counters.set(parent, index + 1);
    if (entry.entry_kind !== 'card') continue;
    const item = payload.creates.find((create) => create.temp_id === entry.key);
    assert.equal(item.position, 100 * (index + 1), `position mismatch for ${entry.key}`);
    if (parent === null) assert.equal('parent_temp_id' in item, false, `root create ${entry.key} must omit parent_temp_id`);
    else assert.equal(item.parent_temp_id, parent);
    assert.equal(item.source_type, 'soulstream-seed');
    assert.equal(item.source_ref, `${installId}:${entry.key}`);
  }
});

// --- link blocks -----------------------------------------------------------

test('ja link block fixture resolves a translated include section outside example fences', () => {
  const entry = { key: 'skill.fixture', title: 'fixture', content: "body_node_id: '{{node_id:skill.fixture.body}}'" };
  const body = { key: 'skill.fixture.body', title: 'body', content: '## 원문' };
  const caller = { key: 'caller', content: '```link\ninclude: fixture\nsection: 원문\n```' };
  const original = [entry, body, caller];
  const translatedCaller = {
    ...caller,
    content: '~~~~markdown\n```link\ninclude: example\n```\n~~~~\n' + caller.content.replace('원문', '見出し'),
  };
  const compare = (content) => compareLinkBlocks('ja', original, [entry, { ...body, content }, translatedCaller]);
  assert.throws(() => compare('```markdown\n## 見出し\n```'), /ja caller link block #1 section "見出し" must match one heading in skill\.fixture\.body/);
  compare('### `見出し` <!-- comment -->');
});

// --- forbidden patterns ----------------------------------------------------

// Every string in the seed, wherever it sits: object keys and values at any depth (entry key, title,
// content, tags, parent, symlink target, exported keys and the rest). Locations name the entry key and
// the field path only.
function seedStringFields(seed) {
  const rows = [];
  const walk = (value, where) => {
    if (typeof value === 'string') rows.push([where, value]);
    else if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${where}[${index}]`));
    else if (value !== null && typeof value === 'object') {
      for (const [name, item] of Object.entries(value)) {
        rows.push([`${where} (field name)`, name]);
        walk(item, `${where}.${name}`);
      }
    }
  };
  for (const [name, value] of Object.entries(seed)) {
    if (name === 'entries') continue;
    walk(value, `seed.${name}`);
  }
  for (const entry of seed.entries) walk(entry, `entry:${entry.key}`);
  return rows;
}

// --- install profile arguments ---------------------------------------------

test('agent_id / profile / mcp_profile arguments match the install profile set', () => {
  const allowed = {
    agent_id: new Set(['seosoyoung', 'seosoyoung-pas', 'card-orchestrator', 'claude-default', 'codex-default', 'antigravity-default']),
    agentId: new Set(['seosoyoung', 'seosoyoung-pas', 'card-orchestrator', 'claude-default', 'codex-default', 'antigravity-default']),
    profile: new Set(['default', 'pas']),
    mcp_profile: new Set(['default', 'pas']),
  };
  const placeholder = '실행할-에이전트-ID';
  const assignmentRe = /(?:^|[^\w-])["']?(agent_id|agentId|mcp_profile|profile)["']?\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^\s,;)}\]]+))/g;
  let seen = 0;
  for (const entry of CARDS) {
    for (const match of (entry.content ?? '').matchAll(assignmentRe)) {
      const name = match[1];
      const value = match[2] ?? match[3] ?? match[4];
      seen += 1;
      if (name === 'agent_id' || name === 'agentId') {
        assert.ok(allowed[name].has(value) || value === placeholder, `unknown agent id in ${entry.key}: ${value}`);
      } else {
        assert.ok(allowed[name].has(value), `unknown ${name} in ${entry.key}: ${value}`);
      }
    }
  }
  assert.ok(seen >= 4, `expected the seed profile arguments, found ${seen}`);
});

// --- first request path -----------------------------------------------------

test('first request path: the PAS role runs cards under the default agent and card-work links documents by relative url', () => {
  const content = (key) => SEED.entries.find((entry) => entry.key === key)?.content ?? '';
  const pasRole = content('seosoyoung.rules_pas.pas_role');
  assert.ok(pasRole.includes('run=true'), 'pas_role must tell the PAS to run the card it creates');
  assert.ok(pasRole.includes('agent_id: "seosoyoung"'), 'pas_role must name the default card assignee agent');
  const cardWork = content('skill.card_work.body');
  assert.ok(cardWork.includes('/?document='), 'card-work must show the relative document link form');
  assert.ok(cardWork.includes('document.id'), 'card-work must name the document id to use');
});

// --- portraits -------------------------------------------------------------

test('portraits: PNG signature, no text chunks, under 1 MiB', () => {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const FORBIDDEN = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf']);
  for (const [name, file] of Object.entries(PORTRAIT_PATHS)) {
    const buffer = fs.readFileSync(file);
    assert.ok(buffer.length < 1024 * 1024, `${name} portrait exceeds 1 MiB`);
    assert.deepEqual(buffer.subarray(0, 8), PNG_SIGNATURE, `${name} portrait is not a PNG`);
    let offset = 8;
    const types = [];
    while (offset + 12 <= buffer.length) {
      const length = buffer.readUInt32BE(offset);
      const type = buffer.toString('latin1', offset + 4, offset + 8);
      types.push(type);
      offset += 12 + length;
      if (type === 'IEND') break;
    }
    assert.ok(types.includes('IHDR') && types.includes('IEND'), `${name} portrait is missing IHDR/IEND`);
    for (const type of types) assert.equal(FORBIDDEN.has(type), false, `${name} portrait contains ${type}`);
  }
});

// --- self-growing install: new skills, catalog and guidance --------------------

const entryByKey = (key) => SEED.entries.find((entry) => entry.key === key);
const contentOf = (key) => entryByKey(key)?.content ?? '';
const NEW_SKILLS = {
  'skill.daily_review': 'daily-review',
  'skill.skill_creator': 'skill-creator',
  'skill.git_setup': 'git-setup',
  'skill.html_make': 'html-make',
};
const HTML_PRESET = 'catalog.html_design_preset';
const SHARD_KEYS = ['index_preset', 'apple_preset', 'astryx_preset'].map((name) => `${HTML_PRESET}.shard.${name}`);
const NEWLY_WRITTEN_KEYS = [
  ...Object.keys(NEW_SKILLS).flatMap((key) => [key, `${key}.body`]),
  HTML_PRESET,
  `${HTML_PRESET}.body`,
  ...SHARD_KEYS,
  'projects.root',
  'common.soulstream_guide.settings',
];

test('new skills: structure card names the body card, body cards exist, skill-creator stays under 4,000 chars', () => {
  for (const [key, name] of Object.entries(NEW_SKILLS)) {
    const structure = entryByKey(key);
    assert.equal(structure.title, name);
    assert.equal(structure.parent, 'common.skills');
    assert.ok(structure.content.includes(`body_node_id: '{{node_id:${key}.body}}'`), `${key} must point at its body card`);
    assert.equal(entryByKey(`${key}.body`)?.parent, key, `${key}.body must sit under the skill`);
    assert.ok(contentOf(`${key}.body`).length > 500, `${key} body is too short`);
  }
  assert.ok(contentOf('skill.skill_creator.body').length <= 4000);
});

test('agent skill symlinks: the main agent gets the seven restored and new skills, the PAS gets recurring-jobs', () => {
  const linked = (parent) => SYMLINKS.filter((entry) => entry.parent === parent).map((entry) => entry.title);
  for (const name of ['recurring-jobs', 'skill-link-blocks', 'atom-tree-cleanup', 'daily-review', 'skill-creator', 'git-setup', 'html-make']) {
    assert.ok(linked('seosoyoung.skills').includes(name), `seosoyoung.skills is missing ${name}`);
  }
  assert.ok(linked('seosoyoung.skills_pas').includes('recurring-jobs'));
});

test('html-design-preset catalog: three shards of 2,000 to 3,500 chars and an html-make that includes it', () => {
  const structure = contentOf(HTML_PRESET);
  assert.match(structure, /composition: bundle/);
  assert.equal(entryByKey(HTML_PRESET).parent, 'common.catalogs');
  assert.equal(entryByKey(`${HTML_PRESET}.body`).parent, HTML_PRESET);
  for (const key of SHARD_KEYS) {
    assert.ok(structure.includes(`node_id: {{node_id:${key}}}`), `catalog must list shard ${key}`);
    assert.equal(entryByKey(key).parent, `${HTML_PRESET}.body`);
    const size = [...contentOf(key)].length;
    assert.ok(size >= 2000 && size <= 3500, `${key} has ${size} chars`);
  }
  const htmlMake = contentOf('skill.html_make.body');
  assert.ok(htmlMake.includes('include: html-design-preset'));
  assert.ok(htmlMake.includes('node "$AGENT_COMMON_FILES_DIR/skills/html-make/scripts/check-ui-css.mjs"'));
  assert.ok(htmlMake.includes('register_attachment'));
  assert.ok(htmlMake.includes('.local/artifacts/'));
  assert.ok(htmlMake.includes('파일 저장소'));
});

test('new skill bodies only link to skills and catalogs that the seed carries', () => {
  const skillNames = new Set(SEED.entries.filter((entry) => entry.parent === 'common.skills').map((entry) => entry.title));
  const catalogNames = new Set(SEED.entries.filter((entry) => entry.parent === 'common.catalogs').map((entry) => entry.title));
  for (const key of Object.keys(NEW_SKILLS)) {
    for (const body of extractLinkBlocks(contentOf(`${key}.body`))) {
      const { kind, fields } = parseLinkBlockBody(body);
      if (kind === 'call') assert.ok(skillNames.has(fields.call), `${key} calls an unknown skill: ${fields.call}`);
      if (kind === 'include') assert.ok(skillNames.has(fields.include) || catalogNames.has(fields.include), `${key} includes an unknown document: ${fields.include}`);
    }
  }
});

test('guidance cards carry the first-conversation, daily-review, repository and project-memory rules', () => {
  const pasRole = contentOf('seosoyoung.rules_pas.pas_role');
  for (const text of ['첫 대화 안내', '카드가 0장', '일간 정리', '`put_report_entry`', '"ask"', 'Asia/Seoul', '저장소 연결 확인', '`git-setup`', '`list_worktrees`']) {
    assert.ok(pasRole.includes(text), `pas_role is missing: ${text}`);
  }
  assert.ok(pasRole.includes('run=true') && pasRole.includes('agent_id: "seosoyoung"'));
  const projects = contentOf('projects.root');
  for (const text of ['개요와 경로', '아키텍처와 결정', '개발 주의사항', '4,000자', '1,500자', '`initial_context`', '`atomReferences`', '`batch_page_operations`', '`expected_version`']) {
    assert.ok(projects.includes(text), `projects.root is missing: ${text}`);
  }
  assert.ok(contentOf('skill.card_work.body').includes('프로젝트 지식 게이트'));
  assert.ok(contentOf('skill.card_work.body').includes('저장소 미설정 오류'));
  assert.ok(contentOf('skill.worktree_manager.body').includes('`git-setup`'));
  assert.ok(contentOf('common.rules.skill_dispatch').includes('스크립트와 자산은 `$AGENT_COMMON_FILES_DIR/skills/<스킬명>/`에서 읽는다.'));
  const settings = contentOf('common.soulstream_guide.settings');
  for (const heading of ['## 개인 환경', '## 세션과 작업', '## 에이전트와 노드', '## 기록과 관리']) assert.ok(settings.includes(heading), `settings is missing ${heading}`);
  for (const tab of ['Git과 저장소', '스킬과 카탈로그', '코딩 에이전트 연결', '파일 저장소']) assert.ok(settings.includes(tab), `settings is missing ${tab}`);
  assert.ok(contentOf('common.soulstream_guide.config_files').includes('`AGENT_COMMON_FILES_DIR`'));
});

test('newly written seed text avoids the long hyphen, the middle dot and the em dash', () => {
  for (const key of NEWLY_WRITTEN_KEYS) {
    assert.equal(/[―·—]/.test(contentOf(key)), false, `forbidden dash or middle dot in ${key}`);
  }
});

test('seed guidance names the settings tabs the way the dashboard does', () => {
  const unified = SEED.entries.filter((entry) => /작업과 실행/.test(`${entry.title ?? ''}\n${entry.content ?? ''}`)).map((entry) => entry.key);
  assert.deepEqual(unified, [], 'the dashboard has no 작업과 실행 group');
  const codingLogin = contentOf('common.soulstream_guide.coding_login');
  assert.ok(codingLogin.includes('코딩 에이전트 연결') && codingLogin.includes('에이전트와 노드'));
  assert.ok(contentOf('common.soulstream_guide.first_window').includes('코딩 에이전트 연결'));
  const staleTab = /설정 → 코딩 에이전트(?! 연결)|설정 → 에이전트(?!와 노드| 프로필)/;
  const stale = SEED.entries.filter((entry) => staleTab.test(entry.content ?? '')).map((entry) => entry.key);
  assert.deepEqual(stale, [], 'settings tabs must use the dashboard labels');
});

const adminMark = { ko: '(관리자)', en: ' (Admin)', ja: '（管理者）', 'zh-Hans': '（管理员）' };

for (const lang of completeLanguages) {
  const { seed } = readLocalizedSeed(SEED_PATH, lang);
  const cards = seed.entries.filter((entry) => entry.entry_kind === 'card');
  const file = new URL(`../../packages/i18n/src/locales/${lang}/settings.json`, import.meta.url);
  const dictionary = JSON.parse(fs.readFileSync(file, 'utf8'));

  test(`${lang} titles are non-empty and at most 50 code points`, () => {
    for (const entry of seed.entries) {
      assert.equal(typeof entry.title, 'string');
      assert.ok(entry.title.length > 0, `empty title for ${entry.key}`);
      assert.ok([...entry.title].length <= 50, `title over 50 code points: ${entry.key}`);
    }
  });

  test(`${lang} placeholders: 47 cards, 79 references, 70 distinct card keys, no card_id form`, () => {
    const replacements = cards.filter((entry) => placeholderKeys(entry.content ?? '').length > 0);
    const symlinks = seed.entries.filter((entry) => entry.entry_kind === 'symlink');
    const cardKeys = new Set(cards.map((entry) => entry.key));
    const distinct = new Set();
    let references = 0;
    for (const entry of replacements) {
      for (const key of placeholderKeys(entry.content ?? '')) {
        references += 1;
        distinct.add(key);
        assert.ok(cardKeys.has(key), `placeholder points at a non-card key: ${key}`);
      }
    }
    assert.equal(replacements.length, 47);
    assert.equal(references, 79);
    assert.equal(distinct.size, 70);
    for (const [, text] of seedTexts(seed)) {
      assert.equal(text.includes('{{card_id:'), false, 'seed must not use the {{card_id: placeholder form');
    }
    assert.equal(symlinks.some((entry) => entry.content !== undefined), false, 'symlink entries must not carry content');
  });

  test(`${lang} link blocks follow the load_skill rules and contain only placeholder node references`, () => {
    let blockCount = 0;
    for (const entry of cards) {
      for (const body of extractLinkBlocks(entry.content ?? '')) {
        blockCount += 1;
        assert.doesNotThrow(() => parseLinkBlockBody(body), `invalid link block in ${entry.key}`);
        assert.equal(UUID_RE.test(body), false, `raw node id inside a link block of ${entry.key}`);
        UUID_RE.lastIndex = 0;
        for (const line of body.split('\n')) {
          const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
          if (!match) continue;
          if (!/node_?id/i.test(match[1])) continue;
          assert.match(match[2].trim(), /^\{\{node_id:[^}]+\}\}$/, `node reference must be a placeholder in ${entry.key}`);
        }
      }
    }
    assert.ok(blockCount > 0, 'the seed is expected to contain link blocks');
  });

  if (lang !== 'ko') {
    test(`${lang} link blocks match the Korean seed and resolve include sections`, () => {
      compareLinkBlocks(lang, CARDS, cards);
    });
  }

  test(`${lang} forbidden patterns: seed titles, content and exports contain only public text`, () => {
    for (const [where, text] of seedTexts(seed)) {
      const violation = forbiddenSeedText(text);
      assert.equal(violation, undefined, `${where}: ${violation}`);
    }
  });

  test(`${lang} all seed strings follow the public seed text rules`, () => {
    for (const [where, text] of seedStringFields(seed)) {
      const violation = forbiddenSeedText(text);
      assert.equal(violation, undefined, `${where}: ${violation}`);
    }
  });

  test(`${lang} installer text uses the dashboard coding agent login path`, () => {
    const expected = `${dictionary.title} → ${dictionary.tabs.coding_agents.label}`;
    assert.equal(readInstallerText(lang).codingAgentsPath, expected);
  });

  test(`${lang} settings card lists every dashboard group and tab with the same admin marks`, () => {
    const source = fs.readFileSync(new URL('../../unified-dashboard/client/components/config/configTabs.ts', import.meta.url), 'utf8');
    const tabs = [...source.matchAll(/\{ id: "(\w+)", label: "([^"]+)",[^\n]*?group: "(\w+)", adminOnly: (true|false)/g)]
      .map(([, id, , group, admin]) => ({ label: dictionary.tabs[id].label, group, adminOnly: admin === 'true' }));
    const groups = [...source.matchAll(/\{ id: "(\w+)", label: "([^"]+)" \}/g)].map(([, id]) => dictionary.groups[id]);
    assert.equal(tabs.length, 20, 'expected 20 CONFIG_TABS labels');
    assert.equal(groups.length, 4, 'expected 4 CONFIG_TAB_GROUPS labels');
    const settings = seed.entries.find((entry) => entry.key === 'common.soulstream_guide.settings').content;
    for (const group of groups) assert.ok(settings.includes(`## ${group}\n`), `settings is missing the group heading ${group}`);
    for (const tab of tabs) {
      const marked = `- ${tab.label}${adminMark[lang]}:`;
      const line = settings.split('\n').find((text) => text.startsWith(`- ${tab.label}:`) || text.startsWith(marked));
      assert.ok(line, `settings is missing a line for the tab ${tab.label}`);
      assert.equal(line.startsWith(marked), tab.adminOnly, `admin mark of ${tab.label} differs from configTabs.ts`);
    }
    if (lang === 'ko') {
      const guide = contentOf('skill.soulstream_guide.body');
      assert.ok(!guide.includes('세 묶음') && guide.includes('네 묶음'), 'the guide skill must say four groups');
    }
  });
}
